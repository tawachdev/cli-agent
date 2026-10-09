import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import { OpenAICompatProvider } from "../src/engine/models/openai-provider";
import { InMemoryKeyStore } from "../src/engine/models/keystore";
import { ProviderRegistry } from "../src/engine/models/registry";
import { BindingsStore } from "../src/engine/models/bindings";
import { ToolRegistry } from "../src/engine/tools/registry";
import { StreamRegistry } from "../src/engine/api/ws/agent-stream";
import { BrandStore } from "../src/engine/brand";

function buildApp(options: { workspaceRoot: string; registry: ProviderRegistry }) {
  const db = openDb(":memory:");
  runMigrations(db, migrations);
  const audit = new SqliteAudit(db);
  const pending = new PendingPermissions();
  const permissions = new PermissionEngine(defaultPolicyFile(), pending, audit);
  const bindings = new BindingsStore(options.workspaceRoot, {}, {
    coder: "stub-coder",
    general: "stub-general",
    mimon1: "stub-general",
    mimon2: "stub-coder",
    mimon3: "stub-general",
    mimonMax: "stub-coder",
  });
  const agent = new Agent({
    db,
    router: new ModelRouter(() => ({ provider: new OpenAICompatProvider("http://127.0.0.1:1", "stub-key", "stub"), providerName: "fake", model: "test-model" })),
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
    info: { workspaceRoot: "/tmp", model: "test-model", numCtx: 4096, version: "0.2.0" },
    bindings,
    registry: options.registry,
    workspaceRoot: options.workspaceRoot,
    dataDir: options.workspaceRoot,
    brand: new BrandStore(options.workspaceRoot, {}),
  });
  return { app, db, audit, bindings };
}

function freshRegistry(keystore: InMemoryKeyStore): ProviderRegistry {
  return new ProviderRegistry(keystore, [], new OpenAICompatProvider("http://127.0.0.1:1", "stub-key", "stub"));
}

describe("setup status and skip", () => {
  it("reports needsSetup on a fresh workspace and clears it after skip", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "mimon-setup-"));
    const { app, db } = buildApp({ workspaceRoot: workspace, registry: freshRegistry(new InMemoryKeyStore()) });

    const before = (await (await app.request("/setup")).json()) as { needsSetup: boolean };
    expect(before.needsSetup).toBe(true);

    const skipped = await app.request("/setup/skip", { method: "POST" });
    expect(((await skipped.json()) as { ok: boolean }).ok).toBe(true);
    expect(existsSync(join(workspace, ".agent", "onboarded"))).toBe(true);

    const after = (await (await app.request("/setup")).json()) as { needsSetup: boolean };
    expect(after.needsSetup).toBe(false);

    const rows = db.query("SELECT type FROM audit_events WHERE type LIKE 'setup%'").all() as Array<{ type: string }>;
    expect(rows.map((r) => r.type)).toEqual(["setup.skipped"]);
  });

  it("clears needsSetup when any provider key or custom binding exists", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "mimon-setup-"));
    const keystore = new InMemoryKeyStore();
    const registry = freshRegistry(keystore);
    const app = buildApp({ workspaceRoot: workspace, registry }).app;

    const untouched = (await (await app.request("/setup")).json()) as { needsSetup: boolean };
    expect(untouched.needsSetup).toBe(true);

    keystore.set("anthropic", "sk-ant");
    const withKey = (await (await app.request("/setup")).json()) as { needsSetup: boolean };
    expect(withKey.needsSetup).toBe(false);

    const workspace2 = mkdtempSync(join(tmpdir(), "mimon-setup-"));
    const built = buildApp({ workspaceRoot: workspace2, registry: freshRegistry(new InMemoryKeyStore()) });
    await built.bindings.set("mimon2", "anthropic/claude-sonnet-4-5");
    const withBinding = (await (await built.app.request("/setup")).json()) as { needsSetup: boolean };
    expect(withBinding.needsSetup).toBe(false);
  });
});
