import { describe, expect, it } from "bun:test";
import { Agent, SessionNotFoundError, TurnError } from "../src/engine/core/agent/agent";
import { createSession } from "../src/engine/core/agent/state";
import { SqliteAudit } from "../src/engine/core/audit/audit";
import { PermissionEngine } from "../src/engine/core/permissions/engine";
import { defaultPolicyFile } from "../src/engine/core/permissions/policy";
import { openDb } from "../src/engine/db/client";
import { runMigrations } from "../src/engine/db/migrate";
import { migrations } from "../src/engine/db/migrations";
import { ModelRouter } from "../src/engine/models/router";
import type { GenerateRequest, ModelProvider, StreamChunk } from "../src/engine/models/types";
import { ToolRegistry } from "../src/engine/tools/registry";
import { fsReadTool } from "../src/engine/tools/fs/read";

class FakeProvider implements ModelProvider {
  readonly requests: GenerateRequest[] = [];

  constructor(private readonly turns: StreamChunk[][]) {}

  async *complete(req: GenerateRequest): AsyncGenerator<StreamChunk> {
    this.requests.push(req);
    for (const chunk of this.turns.shift() ?? []) {
      yield chunk;
    }
  }
}

interface RecordedEvent {
  type: string;
  payload: unknown;
}

function makeAgent(
  db: ReturnType<typeof openDb>,
  provider: ModelProvider,
  maxSteps?: number,
  checkCommand?: string,
): Agent {
  const audit = new SqliteAudit(db);
  const pending = { create: async () => true, resolve: () => ({ ok: false }) };
  const permissions = new PermissionEngine(defaultPolicyFile(), pending, audit);
  const tools = new ToolRegistry(permissions);
  tools.register(fsReadTool);
  return new Agent({
    db,
    router: new ModelRouter(() => ({ provider, providerName: "fake", model: "fake" })),
    tools,
    toolContext: { workspaceRoot: "/tmp" },
    numCtx: 4096,
    temperature: 0.2,
    maxSteps,
    audit,
    permissions,
    checkCommand,
  });
}

describe("agent orchestration", () => {
  it("executes with tools, verifies and completes with a taskId", async () => {
    const db = openDb(":memory:");
    runMigrations(db, migrations);
    const provider = new FakeProvider([
      [
        { type: "token", text: "Let me read the file." },
        { type: "tool_call", call: { name: "fs.read", arguments: { path: "etc/hostname" } } },
      ],
      [{ type: "token", text: "Done reading." }],
    ]);
    const agent = makeAgent(db, provider);
    const session = createSession(db, null);
    const events: RecordedEvent[] = [];

    const result = await agent.runTask(session.id, "read a file", "coder", (type, payload) =>
      events.push({ type, payload }),
    );

    expect(result.taskId).toBeTruthy();
    expect(result.answer).toBe("Done reading.");

    const types = events.map((event) => event.type);
    expect(types).toEqual([
      "state.changed",
      "turn.started",
      "token.delta",
      "message.completed",
      "tool.requested",
      "tool.started",
      "tool.result",
      "token.delta",
      "message.completed",
      "turn.completed",
      "state.changed",
    ]);
    expect(provider.requests[0]?.tools).toBeDefined();

    const states = events
      .filter((event) => event.type === "state.changed")
      .map((event) => (event.payload as { state: string }).state);
    expect(states).toEqual(["executing", "completed"]);

    const taskRow = db.query("SELECT state, plan, result FROM tasks").get() as {
      state: string;
      plan: string | null;
      result: string;
    };
    expect(taskRow.state).toBe("completed");
    expect(taskRow.plan).toBeNull();
    expect(JSON.parse(taskRow.result)).toMatchObject({ answer: "Done reading.", verified: false });
    db.close();
  });

  it("enters verifying and refuses completion when the check command fails", async () => {
    const db = openDb(":memory:");
    runMigrations(db, migrations);
    const provider = new FakeProvider([[{ type: "token", text: "Done." }]]);
    const agent = makeAgent(db, provider, undefined, "exit 3");
    const session = createSession(db, null);
    const events: RecordedEvent[] = [];

    await expect(
      agent.runTask(session.id, "answer", "coder", (type, payload) => events.push({ type, payload })),
    ).rejects.toThrow(TurnError);

    const states = events
      .filter((event) => event.type === "state.changed")
      .map((event) => (event.payload as { state: string }).state);
    expect(states).toEqual(["executing", "verifying", "failed"]);

    const verify = events.find((event) => event.type === "verify.result");
    expect(verify?.payload).toMatchObject({ status: "failed", ok: false });

    const taskRow = db.query("SELECT state, result FROM tasks").get() as { state: string; result: string | null };
    expect(taskRow.state).toBe("failed");
    expect(taskRow.result).toBeNull();
    db.close();
  });

  it("completes through verifying when the check command passes", async () => {
    const db = openDb(":memory:");
    runMigrations(db, migrations);
    const provider = new FakeProvider([[{ type: "token", text: "Done." }]]);
    const agent = makeAgent(db, provider, undefined, "exit 0");
    const session = createSession(db, null);
    const events: RecordedEvent[] = [];

    await agent.runTask(session.id, "answer", "coder", (type, payload) => events.push({ type, payload }));

    const states = events
      .filter((event) => event.type === "state.changed")
      .map((event) => (event.payload as { state: string }).state);
    expect(states).toEqual(["executing", "verifying", "completed"]);
    const taskRow = db.query("SELECT state, result FROM tasks").get() as { state: string; result: string };
    expect(taskRow.state).toBe("completed");
    expect(JSON.parse(taskRow.result)).toMatchObject({ verified: true });
    db.close();
  });

  it("fails the task when the loop exceeds max steps", async () => {
    const db = openDb(":memory:");
    runMigrations(db, migrations);
    const looping: StreamChunk[] = [
      { type: "tool_call", call: { name: "fs.read", arguments: { path: "x" } } },
    ];
    const provider = new FakeProvider([looping, looping]);
    const agent = makeAgent(db, provider, 2);
    const session = createSession(db, null);
    const events: RecordedEvent[] = [];

    await expect(
      agent.runTask(session.id, "loop", "coder", (type, payload) => events.push({ type, payload })),
    ).rejects.toThrow(TurnError);

    const failed = events.find((event) => event.type === "turn.failed");
    expect(failed?.payload).toMatchObject({ reason: "turn exceeded max steps (2)" });
    const taskRow = db.query("SELECT state FROM tasks").get() as { state: string };
    expect(taskRow.state).toBe("failed");
    db.close();
  });

  it("marks the task aborted when the signal fires", async () => {
    const db = openDb(":memory:");
    runMigrations(db, migrations);
    const hangUntilAborted: ModelProvider = {
      async *complete(req, signal) {
        await new Promise<never>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
        yield { type: "token", text: "unreachable" };
      },
    };
    const agent = makeAgent(db, hangUntilAborted);
    const session = createSession(db, null);
    const events: RecordedEvent[] = [];

    const runPromise = agent.runTask(session.id, "abort me", "coder", (type, payload) =>
      events.push({ type, payload }),
    );
    await Bun.sleep(10);
    expect(agent.abortSession(session.id)).toBe(true);
    await expect(runPromise).rejects.toThrow(TurnError);

    const aborted = events.find((event) => event.type === "turn.aborted");
    expect(aborted).toBeDefined();
    const taskRow = db.query("SELECT state FROM tasks").get() as { state: string };
    expect(taskRow.state).toBe("aborted");
    db.close();
  });

  it("throws SessionNotFoundError for an unknown session", async () => {
    const db = openDb(":memory:");
    runMigrations(db, migrations);
    const agent = makeAgent(db, new FakeProvider([]));
    await expect(agent.runTask("missing", "task", "coder", () => {})).rejects.toThrow(
      SessionNotFoundError,
    );
    db.close();
  });
});
