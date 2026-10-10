import { describe, expect, it } from "bun:test";
import { Agent } from "../src/engine/core/agent/agent";
import { createSession } from "../src/engine/core/agent/state";
import { runTurn } from "../src/engine/core/agent/loop";
import { SqliteAudit } from "../src/engine/core/audit/audit";
import { PermissionEngine } from "../src/engine/core/permissions/engine";
import { PendingPermissions } from "../src/engine/core/permissions/pending";
import { defaultPolicyFile } from "../src/engine/core/permissions/policy";
import { openDb, type Db } from "../src/engine/db/client";
import { runMigrations } from "../src/engine/db/migrate";
import { migrations } from "../src/engine/db/migrations";
import { ModelRouter } from "../src/engine/models/router";
import type { GenerateRequest, ModelProvider, StreamChunk } from "../src/engine/models/types";
import { ToolRegistry } from "../src/engine/tools/registry";
import { createServer } from "../src/engine/app/server";
import { createLogger } from "../src/engine/shared/logger";
import { StreamRegistry } from "../src/engine/api/ws/agent-stream";
import { BrandStore } from "../src/engine/brand";

const PNG_1X1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const JPEG_BYTES = [0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
const JPEG_B64 = Buffer.from(Uint8Array.from(JPEG_BYTES)).toString("base64");

class FakeProvider implements ModelProvider {
  readonly requests: GenerateRequest[] = [];

  constructor(private readonly turns: StreamChunk[][]) {}

  async *complete(req: GenerateRequest): AsyncGenerator<StreamChunk> {
    this.requests.push(req);
    for (const chunk of this.turns.shift() ?? []) yield chunk;
  }
}

function makeAgent(db: Db, provider: ModelProvider): Agent {
  const audit = new SqliteAudit(db);
  const pending = { create: async () => true, resolve: () => ({ ok: false }) };
  const permissions = new PermissionEngine(defaultPolicyFile(), pending, audit);
  return new Agent({
    agentName: () => "TEST",
    db,
    router: new ModelRouter(() => ({ provider, providerName: "fake", model: "fake" })),
    tools: new ToolRegistry(permissions),
    toolContext: { workspaceRoot: "/tmp" },
    numCtx: 4096,
    temperature: 0.2,
    audit,
    permissions,
  });
}

function lastUserImages(messages: GenerateRequest["messages"]): string[] | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    if (message.role === "user") return message.images;
  }
  return undefined;
}

describe("images through the agent", () => {
  it("attaches images to the newest user message in the provider request", async () => {
    const db = openDb(":memory:");
    runMigrations(db, migrations);
    const provider = new FakeProvider([[{ type: "token", text: "I see a red square." }]]);
    const agent = makeAgent(db, provider);
    const session = createSession(db, null);

    await agent.runTask(session.id, "what is this?", "coder", () => {}, [PNG_1X1]);

    const request = provider.requests.at(-1)!;
    expect(lastUserImages(request.messages)).toEqual([PNG_1X1]);
    expect(request.messages.at(-1)?.role).toBe("user");
    db.close();
  });

  it("sends no images field when the task is text-only", async () => {
    const db = openDb(":memory:");
    runMigrations(db, migrations);
    const provider = new FakeProvider([[{ type: "token", text: "ok" }]]);
    const agent = makeAgent(db, provider);
    const session = createSession(db, null);

    await agent.runTask(session.id, "plain question", "coder", () => {});

    expect(lastUserImages(provider.requests[0]!.messages)).toBeUndefined();
    db.close();
  });

  it("runTurn keeps images on the user message across compaction-sized histories", async () => {
    const db = openDb(":memory:");
    runMigrations(db, migrations);
    const provider = new FakeProvider([[{ type: "token", text: "seen" }]]);
    const audit = new SqliteAudit(db);
    const pending = { create: async () => true, resolve: () => ({ ok: false }) };
    const permissions = new PermissionEngine(defaultPolicyFile(), pending, audit);
    const session = createSession(db, null);
    const result = await runTurn(
      {
        agentName: () => "TEST",
        db,
        binding: { provider, providerName: "fake", model: "fake" },
        tools: new ToolRegistry(permissions),
        toolContext: { workspaceRoot: "/tmp" },
        publish: () => {},
        numCtx: 4096,
        temperature: 0.2,
        sessionId: session.id,
        taskId: "task-1",
      },
      "look closely",
      [PNG_1X1],
    );
    expect(result.answer).toBe("seen");
    expect(lastUserImages(provider.requests[0]!.messages)).toEqual([PNG_1X1]);
    db.close();
  });
});

describe("images on the /agent/run route", () => {
  function buildApp() {
    const db = openDb(":memory:");
    runMigrations(db, migrations);
    const audit = new SqliteAudit(db);
    const pending = new PendingPermissions();
    const permissions = new PermissionEngine(defaultPolicyFile(), pending, audit);
    const provider = new FakeProvider([[{ type: "token", text: "ok" }]]);
    const agent = makeAgent(db, provider);
    const app = createServer({
      db,
      logger: createLogger("error"),
      agent,
      streams: new StreamRegistry(),
      pending,
      audit,
      info: { workspaceRoot: "/tmp", model: "fake", numCtx: 4096, version: "0.2.0" },
      bindings: {
        get: () => "fake",
        source: () => "default",
        all: () => ({}) as Record<string, string>,
        set: async () => {},
      } as never,
      registry: {
        has: () => false,
        list: () => [],
        splitBinding: () => ({ def: null, model: "fake" }),
        resolve: () => ({ provider, providerName: "fake", model: "fake" }),
        setKey: () => {},
        deleteKey: () => {},
        test: async () => ({ ok: true }),
      } as never,
      workspaceRoot: "/tmp",
      dataDir: "/tmp",
      brand: new BrandStore("/tmp", process.env),
    });
    return { app, db, provider };
  }

  it("rejects non-image payloads with 400 before touching the model", async () => {
    const { app, db, provider } = buildApp();
    const session = (await (await app.request("/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    })).json()) as { session: { id: string } };

    const bad = await app.request("/agent/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: session.session.id, task: "look", images: ["not-an-image"] }),
    });
    expect(bad.status).toBe(400);
    expect(provider.requests).toHaveLength(0);

    const oversized = await app.request("/agent/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: session.session.id, task: "look", images: ["A".repeat(9 * 1024 * 1024)] }),
    });
    expect(oversized.status).toBe(400);
    db.close();
  });

  it("accepts data URLs, strips the prefix and forwards raw base64 to the provider", async () => {
    const { app, db, provider } = buildApp();
    const session = (await (await app.request("/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    })).json()) as { session: { id: string } };

    const run = await app.request("/agent/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionId: session.session.id,
        task: "what is this?",
        role: "mimon2",
        images: ["data:image/png;base64," + PNG_1X1, JPEG_B64],
      }),
    });
    expect(run.status).toBe(200);
    const request = provider.requests.at(-1)!;
    expect(lastUserImages(request.messages)).toEqual([PNG_1X1, JPEG_B64]);
    db.close();
  });
});
