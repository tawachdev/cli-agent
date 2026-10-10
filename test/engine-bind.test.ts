import { describe, expect, it } from "bun:test";
import { loadConfig } from "../src/engine/app/config";
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

describe("engine bind config", () => {
  it("accepts loopback hostnames", () => {
    for (const hostname of ["127.0.0.1", "localhost", "::1"]) {
      expect(loadConfig({ AGENT_HOSTNAME: hostname }).hostname.toLowerCase()).toBe(hostname);
    }
    expect(loadConfig({}).hostname).toBe("127.0.0.1");
  });

  it("hard-rejects wildcard and non-loopback binds", () => {
    for (const hostname of ["0.0.0.0", "::", "", "192.168.1.10", "0.0.0.0:7800", "example.com"]) {
      expect(() => loadConfig({ AGENT_HOSTNAME: hostname })).toThrow(/loopback/);
    }
  });
});

function makeApp(hostname?: string) {
  const db = openDb(":memory:");
  runMigrations(db, migrations);
  const audit = new SqliteAudit(db);
  const pending = new PendingPermissions();
  const permissions = new PermissionEngine(defaultPolicyFile(), pending, audit);
  const registry = new ProviderRegistry(
    new InMemoryKeyStore(),
    [],
    new OpenAICompatProvider("http://127.0.0.1:1", "stub-key", "stub"),
  );
  const bindings = new BindingsStore(
    "/tmp",
    {},
    {
      coder: "test-model",
      general: "test-model",
      mimon1: "test-model",
      mimon2: "test-model",
      mimon3: "test-model",
      mimonMax: "test-model",
    },
  );
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
  return createServer({
    db,
    logger: createLogger("error"),
    hostname,
    agent,
    streams: new StreamRegistry(),
    pending,
    audit,
    info: { workspaceRoot: "/tmp", model: "test-model", numCtx: 4096, version: "0.0.0" },
    bindings,
    registry,
    workspaceRoot: "/tmp",
    dataDir: "/tmp",
    brand: new BrandStore("/tmp", process.env),
  });
}

describe("host/origin middleware", () => {
  it("serves loopback hosts", async () => {
    const app = makeApp("127.0.0.1");
    const ok = await app.request("/health", { headers: { host: "127.0.0.1:7800" } });
    expect(ok.status).toBe(200);
  });

  it("rejects forged Host headers with 403", async () => {
    const app = makeApp("127.0.0.1");
    for (const host of ["evil.example.com", "192.168.1.5:7800", "[fd00::1]:7800"]) {
      const res = await app.request("/health", { headers: { host } });
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ error: "forbidden host" });
    }
  });

  it("rejects non-loopback Origin headers with 403", async () => {
    const app = makeApp("127.0.0.1");
    const res = await app.request("/health", {
      headers: { host: "127.0.0.1:7800", origin: "https://evil.example.com" },
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "forbidden origin" });
  });

  it("accepts loopback Origin headers", async () => {
    const app = makeApp("127.0.0.1");
    const res = await app.request("/health", {
      headers: { host: "127.0.0.1:7800", origin: "http://localhost:5173" },
    });
    expect(res.status).toBe(200);
  });

  it("refuses to even build a server on a wildcard bind", () => {
    for (const hostname of ["0.0.0.0", "::", ""]) {
      expect(() => makeApp(hostname)).toThrow(/wildcard/);
    }
  });
});
