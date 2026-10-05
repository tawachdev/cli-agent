import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
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
import { InMemoryKeyStore } from "../src/engine/models/keystore";
import { ProviderRegistry, loadExtraProviders } from "../src/engine/models/registry";
import { BindingsStore, RUNNABLE_ROLES, type RunnableRole } from "../src/engine/models/bindings";
import { ToolRegistry } from "../src/engine/tools/registry";
import { StreamRegistry, websocket } from "../src/engine/api/ws/agent-stream";
import { BrandStore } from "../src/engine/brand";
import type { ModelRole } from "../src/engine/models/types";

const GOOD_KEY = "sk-mimon-pty-good";

let upstream: ReturnType<typeof Bun.serve> | null = null;
let backend: ReturnType<typeof Bun.serve> | null = null;
let workspace = "";

beforeAll(async () => {
  upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const auth = request.headers.get("authorization") ?? "";
      if (auth !== "Bearer " + GOOD_KEY) {
        return Response.json({ error: { message: "invalid api key" } }, { status: 401 });
      }
      const chunks = ["Labas ", "khouya ", "min ", "pty ", "wizard."].map((text) =>
        "data: " + JSON.stringify({ choices: [{ delta: { content: text } }] }) + "\n\n",
      );
      chunks.push(
        "data: " +
          JSON.stringify({
            choices: [{ delta: {}, finish_reason: "stop" }],
            usage: { prompt_tokens: 10, completion_tokens: 5 },
          }) +
          "\n\n",
      );
      chunks.push("data: [DONE]\n\n");
      return new Response(chunks.join(""), { headers: { "content-type": "text/event-stream" } });
    },
  });

  workspace = mkdtempSync(join(tmpdir(), "mimon-pty-"));
  mkdirSync(join(workspace, ".agent"), { recursive: true });
  writeFileSync(
    join(workspace, ".agent", "providers.json"),
    JSON.stringify([
      { name: "mockmind", kind: "openai", baseUrl: `http://127.0.0.1:${upstream.port}`, models: ["mock-large"] },
    ]) + "\n",
  );

  const db = openDb(":memory:");
  runMigrations(db, migrations);
  const audit = new SqliteAudit(db);
  const pending = new PendingPermissions();
  const permissions = new PermissionEngine(defaultPolicyFile(), pending, audit);
  const keystore = new InMemoryKeyStore();
  const providersPath = join(workspace, ".agent", "providers.json");
  const extras = await loadExtraProviders(providersPath);
  const registry = new ProviderRegistry(keystore, extras, undefined, providersPath);
  const bindings = new BindingsStore(workspace, {}, {
    coder: "stub-coder",
    general: "stub-general",
    mimon1: "stub-general",
    mimon2: "stub-coder",
    mimon3: "stub-general",
    mimonMax: "stub-coder",
  });
  const router = new ModelRouter((role: ModelRole) => {
    const binding = RUNNABLE_ROLES.includes(role as RunnableRole)
      ? bindings.get(role as RunnableRole)
      : "stub-coder";
    return registry.resolve(binding);
  });
  const agent = new Agent({
    db,
    router,
    tools: new ToolRegistry(permissions),
    toolContext: { workspaceRoot: workspace },
    numCtx: 4096,
    temperature: 0.2,
    audit,
    permissions,
  });
  backend = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    websocket,
    fetch: createServer({
      db,
      logger: createLogger("error"),
      agent,
      streams: new StreamRegistry(),
      pending,
      audit,
      info: { workspaceRoot: workspace, model: "pty-e2e", numCtx: 4096, version: "0.1.5" },
      bindings,
      registry,
      workspaceRoot: workspace,
      dataDir: workspace,
      brand: new BrandStore(workspace, {}),
    }).fetch,
  });
});

afterAll(() => {
  backend?.stop(true);
  upstream?.stop(true);
  if (workspace) rmSync(workspace, { recursive: true, force: true });
});

describe("interactive wizard journey over a real pty", () => {
  it(
    "/setup → pick provider → paste key → tiers bound → chat answers — real keystrokes",
    async () => {
      const script = join(import.meta.dir, "..", "scripts", "pty-wizard-test.py");
      const agentTs = join(import.meta.dir, "..", "bin", "agent.ts");
      const proc = Bun.spawn(["python3", script, process.execPath, agentTs, `http://127.0.0.1:${backend!.port}`, GOOD_KEY, workspace], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const [exitCode, stdout] = await Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
      ]);
      console.log(stdout);
      expect(exitCode).toBe(0);
      expect(stdout).toContain("OK: prompt ready");
      expect(stdout).toContain("OK: wizard opened via /setup");
      expect(stdout).toContain("OK: mockmind selected in wizard");
      expect(stdout).toContain("OK: key tested — model picker open");
      expect(stdout).toContain("OK: model picked and tiers bound, back in chat");
      expect(stdout).toContain("OK: answer streamed in the box");
      expect(stdout).toContain("RESULT: PASS");
    },
    120000,
  );
});
