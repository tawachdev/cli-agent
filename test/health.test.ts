import { describe, expect, it } from "bun:test";
import { createServer } from "../src/engine/app/server";
import { createLogger } from "../src/engine/shared/logger";
import { openDb } from "../src/engine/db/client";
import { runMigrations } from "../src/engine/db/migrate";
import { migrations } from "../src/engine/db/migrations";
import { Agent } from "../src/engine/core/agent/agent";
import { SqliteAudit } from "../src/engine/core/audit/audit";
import { PermissionEngine } from "../src/engine/core/permissions/engine";
import { PendingPermissions } from "../src/engine/core/permissions/pending";
import { defaultPolicyFile } from "../src/engine/core/permissions/policy";
import { ModelRouter } from "../src/engine/models/router";
import { InMemoryKeyStore } from "../src/engine/models/keystore";
import { ProviderRegistry } from "../src/engine/models/registry";
import { OpenAICompatProvider } from "../src/engine/models/openai-provider";
import { BindingsStore } from "../src/engine/models/bindings";
import { ToolRegistry } from "../src/engine/tools/registry";
import { StreamRegistry } from "../src/engine/api/ws/agent-stream";
import { BrandStore } from "../src/engine/brand";

describe("GET /health", () => {
  it("returns ok when the database answers", async () => {
    const db = openDb(":memory:");
    runMigrations(db, migrations);
    const audit = new SqliteAudit(db);
    const pending = new PendingPermissions();
    const permissions = new PermissionEngine(defaultPolicyFile(), pending, audit);
    const registry = new ProviderRegistry(new InMemoryKeyStore(), [], new OpenAICompatProvider("http://127.0.0.1:1", "stub-key", "stub"));
    const bindings = new BindingsStore("/tmp", {}, {
      coder: "test-model",
      general: "test-model",
      mimon1: "test-model",
      mimon2: "test-model",
      mimon3: "test-model",
      mimonMax: "test-model",
    });
    const agent = new Agent({
  agentName: () => "TEST",
      db,
      router: new ModelRouter(() => ({ provider: registry.resolve("test-model").provider, providerName: "test", model: "test-model" })),
      tools: new ToolRegistry(permissions),
      toolContext: { workspaceRoot: "/tmp" },
      numCtx: 4096,
      temperature: 0.2,
      audit,
      permissions,
    });
    const app = createServer({
      db,
      logger: createLogger("error"),
      agent,
      streams: new StreamRegistry(),
      pending,
      audit,
      info: { workspaceRoot: "/tmp", model: "test-model", numCtx: 4096, version: "0.2.0" },
      bindings,
      registry,
      workspaceRoot: "/tmp",
      dataDir: "/tmp",
      brand: new BrandStore("/tmp", process.env),
    });
    const response = await app.request("/health");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      service: "agent-backend",
      model: "test-model",
      numCtx: 4096,
    });
    db.close();
  });
});
