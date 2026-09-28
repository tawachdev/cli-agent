import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../src/engine/app/server";
import { createLogger } from "../src/engine/shared/logger";
import { openDb, type Db } from "../src/engine/db/client";
import { runMigrations } from "../src/engine/db/migrate";
import { migrations } from "../src/engine/db/migrations";
import { Agent } from "../src/engine/core/agent/agent";
import { SqliteAudit } from "../src/engine/core/audit/audit";
import { PermissionEngine } from "../src/engine/core/permissions/engine";
import { PendingPermissions } from "../src/engine/core/permissions/pending";
import { defaultPolicyFile } from "../src/engine/core/permissions/policy";
import { ModelRouter } from "../src/engine/models/router";
import { OllamaProvider } from "../src/engine/models/provider";
import { InMemoryKeyStore } from "../src/engine/models/keystore";
import { loadExtraProviders, ProviderRegistry } from "../src/engine/models/registry";
import { BindingsStore } from "../src/engine/models/bindings";
import { ToolRegistry } from "../src/engine/tools/registry";
import { StreamRegistry } from "../src/engine/api/ws/agent-stream";

const OPENAI_SSE = 'data: {"choices":[{"delta":{"content":"OK"}}]}\n\ndata: [DONE]\n\n';

interface CapturedRequest {
  headers: Record<string, string>;
  body: unknown;
}

function startMockOpenAI(): { url: string; stop: () => void; requests: CapturedRequest[] } {
  const requests: CapturedRequest[] = [];
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      requests.push({
        headers: Object.fromEntries(request.headers.entries()),
        body: await request.json().catch(() => null),
      });
      return new Response(OPENAI_SSE, { headers: { "content-type": "text/event-stream" } });
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true), requests };
}

interface AuditRow {
  type: string;
  payload: string;
}

function auditRows(db: Db): AuditRow[] {
  return db.query("SELECT type, payload FROM audit_events WHERE type LIKE 'provider%' OR type LIKE 'model%'").all() as AuditRow[];
}

function buildApp(options: { workspaceRoot: string; env: Record<string, string | undefined>; registry: ProviderRegistry }) {
  const db = openDb(":memory:");
  runMigrations(db, migrations);
  const audit = new SqliteAudit(db);
  const pending = new PendingPermissions();
  const permissions = new PermissionEngine(defaultPolicyFile(), pending, audit);
  const bindings = new BindingsStore(options.workspaceRoot, options.env, {
    coder: "qwen2.5-coder:14b",
    general: "qwen3:14b",
    mimon1: "qwen3:14b",
    mimon2: "qwen2.5-coder:14b",
    mimon3: "qwen3:14b",
    mimonMax: "qwen2.5-coder:14b",
  });
  const agent = new Agent({
    db,
    router: new ModelRouter(() => ({ provider: new OllamaProvider("http://127.0.0.1:11434"), model: "test-model" })),
    tools: new ToolRegistry(permissions),
    toolContext: { workspaceRoot: options.workspaceRoot },
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
    info: { model: "test-model", numCtx: 4096, version: "0.2.0" },
    bindings,
    registry: options.registry,
    workspaceRoot: options.workspaceRoot,
    dataDir: options.workspaceRoot,
  });
  return { app, db, audit, bindings };
}

describe("provider registry and /providers routes", () => {
  it("lists builtins, stores keys in the keystore, never echoes key material", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "mimon-providers-"));
    const mock = startMockOpenAI();
    mkdirSync(join(workspace, ".agent"), { recursive: true });
    writeFileSync(
      join(workspace, ".agent", "providers.json"),
      JSON.stringify([{ name: "cloudbox", kind: "openai", baseUrl: mock.url, models: ["tiny"] }]),
    );
    const extra = await loadExtraProviders(join(workspace, ".agent", "providers.json"));
    const keystore = new InMemoryKeyStore();
    const registry = new ProviderRegistry(keystore, extra, new OllamaProvider("http://127.0.0.1:11434"));
    const { app, db } = buildApp({ workspaceRoot: workspace, env: {}, registry });

    const listed = (await (await app.request("/providers")).json()) as {
      providers: Array<{ name: string; keySet: boolean }>;
    };
    expect(listed.providers.map((p) => p.name)).toEqual(["anthropic", "openai", "deepseek", "glm", "gemini", "cloudbox"]);
    expect(listed.providers.every((p) => p.keySet === false)).toBe(true);

    const missing = await app.request("/providers/nope/key", { method: "PUT", body: JSON.stringify({ key: "sk-x" }) });
    expect(missing.status).toBe(404);

    const saved = await app.request("/providers/cloudbox/key", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: "sk-secret-value" }),
    });
    expect(((await saved.json()) as { ok: boolean }).ok).toBe(true);

    const relisted = (await (await app.request("/providers")).json()) as {
      providers: Array<{ name: string; keySet: boolean }>;
    };
    expect(relisted.providers.find((p) => p.name === "cloudbox")?.keySet).toBe(true);

    const tested = await app.request("/providers/cloudbox/test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "tiny" }),
    });
    const testResult = (await tested.json()) as { ok: boolean };
    expect(testResult.ok).toBe(true);
    expect(mock.requests[0]?.headers["authorization"]).toBe("Bearer sk-secret-value");

    const removed = await app.request("/providers/cloudbox/key", { method: "DELETE" });
    expect(((await removed.json()) as { ok: boolean }).ok).toBe(true);
    expect(keystore.get("cloudbox")).toBeNull();

    const rows = auditRows(db);
    expect(rows.map((r) => r.type)).toEqual(["provider.key_set", "provider.test", "provider.key_deleted"]);
    const serialized = JSON.stringify(rows);
    expect(serialized).not.toContain("sk-secret-value");
    mock.stop();
    db.close();
  });

  it("resolves provider/model bindings and throws a readable error without a key", async () => {
    const keystore = new InMemoryKeyStore();
    const registry = new ProviderRegistry(keystore, [], new OllamaProvider("http://127.0.0.1:11434"));

    const local = registry.resolve("qwen2.5-coder:14b");
    expect(local.model).toBe("qwen2.5-coder:14b");

    expect(() => registry.resolve("anthropic/claude-sonnet-4-5")).toThrow("no API key for \"anthropic\"");

    keystore.set("anthropic", "sk-ant-value");
    const cloud = registry.resolve("anthropic/claude-sonnet-4-5");
    expect(cloud.model).toBe("claude-sonnet-4-5");
    expect(cloud.provider.constructor.name).toBe("AnthropicProvider");
  });

  it("rejects insecure base URLs and filters builtin shadowing in providers.json", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "mimon-providers-"));
    mkdirSync(join(workspace, ".agent"), { recursive: true });
    const path = join(workspace, ".agent", "providers.json");

    writeFileSync(
      path,
      JSON.stringify([{ name: "insecure", kind: "openai", baseUrl: "http://10.0.0.5/v1", models: [] }]),
    );
    await expect(loadExtraProviders(path)).rejects.toThrow("baseUrl must be https://");

    writeFileSync(
      path,
      JSON.stringify([{ name: "openai", kind: "openai", baseUrl: "https://evil.example/v1", models: [] }]),
    );
    expect(await loadExtraProviders(path)).toEqual([]);
  });
});

describe("add and remove custom providers via routes", () => {
  it("creates a provider, persists it, uses it, then removes it", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "mimon-add-"));
    const mock = startMockOpenAI();
    const keystore = new InMemoryKeyStore();
    const registry = new ProviderRegistry(keystore, [], new OllamaProvider("http://127.0.0.1:11434"), join(workspace, ".agent", "providers.json"));
    const { app, db } = buildApp({ workspaceRoot: workspace, env: {}, registry });

    const badUrl = await app.request("/providers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "evil", kind: "openai", baseUrl: "http://10.0.0.9/v1" }),
    });
    expect(badUrl.status).toBe(400);

    const shadow = await app.request("/providers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "openai", kind: "openai", baseUrl: mock.url }),
    });
    expect(((await shadow.json()) as { error: string }).error).toContain("built in");

    const created = await app.request("/providers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "groq", kind: "openai", baseUrl: mock.url + "/", models: ["llama-3.3-70b"] }),
    });
    expect(((await created.json()) as { ok: boolean }).ok).toBe(true);

    const listed = (await (await app.request("/providers")).json()) as {
      providers: Array<{ name: string; builtin: boolean; baseUrl: string }>;
    };
    const groq = listed.providers.find((p) => p.name === "groq");
    expect(groq).toMatchObject({ builtin: false, baseUrl: mock.url });

    const persisted = JSON.parse(readFileSync(join(workspace, ".agent", "providers.json"), "utf8")) as unknown[];
    expect(persisted).toHaveLength(1);

    await app.request("/providers/groq/key", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: "gsk-live" }),
    });
    const tested = await app.request("/providers/groq/test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "llama-3.3-70b" }),
    });
    expect(((await tested.json()) as { ok: boolean }).ok).toBe(true);

    const removed = await app.request("/providers/groq", { method: "DELETE" });
    expect(((await removed.json()) as { ok: boolean }).ok).toBe(true);
    expect(keystore.get("groq")).toBeNull();
    const relisted = (await (await app.request("/providers")).json()) as {
      providers: Array<{ name: string }>;
    };
    expect(relisted.providers.find((p) => p.name === "groq")).toBeUndefined();
    expect(JSON.parse(readFileSync(join(workspace, ".agent", "providers.json"), "utf8")) as unknown[]).toHaveLength(0);

    const removeBuiltin = await app.request("/providers/anthropic", { method: "DELETE" });
    expect(((await removeBuiltin.json()) as { error: string }).error).toContain("built in");

    const rows = auditRows(db);
    expect(rows.map((r) => r.type)).toEqual(
      expect.arrayContaining(["provider.added", "provider.removed"]),
    );
    mock.stop();
    db.close();
  });
});

describe("model bindings via /models routes", () => {
  it("persists bindings to models.json, env wins over file, unknown provider rejected", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "mimon-bindings-"));
    const keystore = new InMemoryKeyStore();
    const registry = new ProviderRegistry(keystore, [], new OllamaProvider("http://127.0.0.1:11434"));
    const { app, db, bindings } = buildApp({ workspaceRoot: workspace, env: {}, registry });

    const rejected = await app.request("/models/coder", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ binding: "nope/model" }),
    });
    expect(rejected.status).toBe(400);

    const saved = await app.request("/models/mimon2", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ binding: "anthropic/claude-sonnet-4-5" }),
    });
    expect(((await saved.json()) as { ok: boolean }).ok).toBe(true);

    const listed = (await (await app.request("/models")).json()) as {
      roles: Array<{ role: string; model: string; source: string }>;
    };
    expect(listed.roles.find((r) => r.role === "mimon2")).toEqual({
      role: "mimon2",
      model: "anthropic/claude-sonnet-4-5",
      source: "file",
    });
    expect(bindings.get("mimon2")).toBe("anthropic/claude-sonnet-4-5");

    const envStore = new BindingsStore(
      workspace,
      { AGENT_MODEL_TIER2: "qwen3:14b" },
      { coder: "a", general: "a", mimon1: "a", mimon2: "a", mimon3: "a", mimonMax: "a" },
    );
    expect(envStore.get("mimon2")).toBe("qwen3:14b");
    expect(envStore.source("mimon2")).toBe("env");

    const rows = auditRows(db);
    expect(rows.map((r) => r.type)).toContain("model.binding_set");
    db.close();
  });
});
