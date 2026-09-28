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

function makeAgent(db: ReturnType<typeof openDb>, provider: ModelProvider, maxSteps?: number): Agent {
  const audit = new SqliteAudit(db);
  const pending = { create: async () => true, resolve: () => false };
  const permissions = new PermissionEngine(defaultPolicyFile(), pending, audit);
  const tools = new ToolRegistry(permissions);
  tools.register(fsReadTool);
  return new Agent({
    db,
    router: new ModelRouter(() => ({ provider, model: "fake" })),
    tools,
    toolContext: { workspaceRoot: "/tmp" },
    numCtx: 4096,
    temperature: 0.2,
    maxSteps,
    audit,
    permissions,
  });
}

describe("agent orchestration", () => {
  it("plans, executes with tools, verifies and completes with a taskId", async () => {
    const db = openDb(":memory:");
    runMigrations(db, migrations);
    const provider = new FakeProvider([
      [{ type: "token", text: "1. Read the file" }],
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
      "plan.updated",
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
      "state.changed",
    ]);
    expect(provider.requests[0]?.tools).toBeUndefined();
    expect(provider.requests[1]?.tools).toBeDefined();

    const states = events
      .filter((event) => event.type === "state.changed")
      .map((event) => (event.payload as { state: string }).state);
    expect(states).toEqual(["planning", "executing", "verifying", "completed"]);

    const taskRow = db.query("SELECT state, plan FROM tasks").get() as { state: string; plan: string };
    expect(taskRow.state).toBe("completed");
    expect(taskRow.plan).toBe("1. Read the file");
    db.close();
  });

  it("fails the task when the loop exceeds max steps", async () => {
    const db = openDb(":memory:");
    runMigrations(db, migrations);
    const looping: StreamChunk[] = [
      { type: "tool_call", call: { name: "fs.read", arguments: { path: "x" } } },
    ];
    const provider = new FakeProvider([[{ type: "token", text: "plan" }], looping, looping]);
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
        if (req.tools) {
          await new Promise<never>((_resolve, reject) => {
            signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          });
        }
        yield { type: "token", text: "plan" };
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
