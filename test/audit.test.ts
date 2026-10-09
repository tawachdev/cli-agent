import { describe, expect, it } from "bun:test";
import { Agent } from "../src/engine/core/agent/agent";
import { createSession } from "../src/engine/core/agent/state";
import { SqliteAudit } from "../src/engine/core/audit/audit";
import { PermissionEngine } from "../src/engine/core/permissions/engine";
import { defaultPolicyFile } from "../src/engine/core/permissions/policy";
import { openDb } from "../src/engine/db/client";
import { runMigrations } from "../src/engine/db/migrate";
import { migrations } from "../src/engine/db/migrations";
import { ModelRouter } from "../src/engine/models/router";
import { OpenAICompatProvider } from "../src/engine/models/openai-provider";
import type { GenerateRequest, ModelProvider, StreamChunk } from "../src/engine/models/types";
import { ToolRegistry } from "../src/engine/tools/registry";
import { fsReadTool } from "../src/engine/tools/fs/read";

class FakeProvider implements ModelProvider {
  constructor(private readonly turns: StreamChunk[][]) {}
  async *complete(req: GenerateRequest): AsyncGenerator<StreamChunk> {
    for (const chunk of this.turns.shift() ?? []) {
      yield chunk;
    }
  }
}

interface AuditRow {
  type: string;
  payload: string;
}

function readAudit(db: ReturnType<typeof openDb>): AuditRow[] {
  return db.query("SELECT type, payload FROM audit_events ORDER BY id").all() as AuditRow[];
}

describe("audit trail", () => {
  it("records durable tool events with truncated arguments for every call", async () => {
    const db = openDb(":memory:");
    runMigrations(db, migrations);
    const audit = new SqliteAudit(db);
    const pending = { create: async () => true, resolve: () => ({ ok: false }) };
    const permissions = new PermissionEngine(defaultPolicyFile(), pending, audit);
    const tools = new ToolRegistry(permissions);
    tools.register(fsReadTool);
    const provider = new FakeProvider([
      [
        { type: "token", text: "reading" },
        { type: "tool_call", call: { name: "fs.read", arguments: { path: "a".repeat(2000) } } },
      ],
      [{ type: "token", text: "done" }],
    ]);
    const agent = new Agent({
      db,
      router: new ModelRouter(() => ({ provider, providerName: "fake", model: "fake" })),
      tools,
      toolContext: { workspaceRoot: "/tmp" },
      numCtx: 4096,
      temperature: 0.2,
      audit,
      permissions,
    });
    const session = createSession(db, null);
    await agent.runTask(session.id, "read", "coder", () => {});

    const types = readAudit(db).map((row) => row.type);
    expect(types).toContain("tool.requested");
    expect(types).toContain("tool.result");
    const requested = JSON.parse(readAudit(db).find((row) => row.type === "tool.requested")?.payload as string);
    expect(requested.name).toBe("fs.read");
    expect(requested.arguments.length).toBeLessThanOrEqual(500);
    const result = JSON.parse(readAudit(db).find((row) => row.type === "tool.result")?.payload as string);
    expect(result).toMatchObject({ name: "fs.read", ok: expect.any(Boolean) });
    db.close();
  });

  it("never records the provider API key in any audit payload", async () => {
    const db = openDb(":memory:");
    runMigrations(db, migrations);
    const audit = new SqliteAudit(db);
    const pending = { create: async () => true, resolve: () => ({ ok: false }) };
    const permissions = new PermissionEngine(defaultPolicyFile(), pending, audit);
    const tools = new ToolRegistry(permissions);
    tools.register(fsReadTool);
    const key = "sk-marker-key-never-leak-123456";
    const provider = new OpenAICompatProvider("http://127.0.0.1:1", key, "unreachable-fake");
    const agent = new Agent({
      db,
      router: new ModelRouter(() => ({ provider, providerName: "fake", model: "fake" })),
      tools,
      toolContext: { workspaceRoot: "/tmp" },
      numCtx: 4096,
      temperature: 0.2,
      audit,
      permissions,
    });
    const session = createSession(db, null);
    await expect(agent.runTask(session.id, "run", "coder", () => {})).rejects.toThrow();

    for (const row of readAudit(db)) {
      expect(row.payload).not.toContain(key);
    }
    db.close();
  });
});
