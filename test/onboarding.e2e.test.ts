import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
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
import { ProviderRegistry } from "../src/engine/models/registry";
import { BindingsStore, RUNNABLE_ROLES, type RunnableRole } from "../src/engine/models/bindings";
import { ToolRegistry } from "../src/engine/tools/registry";
import { StreamRegistry, websocket } from "../src/engine/api/ws/agent-stream";
import { BrandStore } from "../src/engine/brand";
import type { ModelRole } from "../src/engine/models/types";

const GOOD_KEY = "sk-mimon-e2e-good";

interface UpstreamCall {
  auth: string;
  model: string;
  userText: string;
}

function startUpstream(): { server: ReturnType<typeof Bun.serve>; calls: UpstreamCall[]; url: string } {
  const calls: UpstreamCall[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method !== "POST" || !url.pathname.endsWith("/chat/completions")) {
        return Response.json({ error: { message: "unexpected path " + url.pathname } }, { status: 404 });
      }
      const auth = request.headers.get("authorization") ?? "";
      const body = (await request.json()) as { model: string; messages: Array<{ role: string; content: unknown }> };
      const userText = String(
        body.messages.filter((m) => m.role === "user").at(-1)?.content ?? "",
      );
      calls.push({ auth, model: body.model, userText });
      if (auth !== "Bearer " + GOOD_KEY) {
        return Response.json({ error: { message: "invalid api key" } }, { status: 401 });
      }
      const chunks = [
        "Labas ",
        "khouya — ",
        "mock ",
        "provider ",
        "jawab.",
      ].map((text) =>
        "data: " + JSON.stringify({ choices: [{ delta: { content: text } }] }) + "\n\n",
      );
      chunks.push(
        "data: " +
          JSON.stringify({
            choices: [{ delta: {}, finish_reason: "stop" }],
            usage: { prompt_tokens: 42, completion_tokens: 7 },
          }) +
          "\n\n",
      );
      chunks.push("data: [DONE]\n\n");
      return new Response(chunks.join(""), {
        headers: { "content-type": "text/event-stream" },
      });
    },
  });
  return { server, calls, url: `http://127.0.0.1:${server.port}` };
}

function startBackend(workspaceRoot: string, upstreamUrl: string): { server: ReturnType<typeof Bun.serve>; url: string } {
  const db = openDb(":memory:");
  runMigrations(db, migrations);
  const audit = new SqliteAudit(db);
  const pending = new PendingPermissions();
  const permissions = new PermissionEngine(defaultPolicyFile(), pending, audit);
  const keystore = new InMemoryKeyStore();
  const providersPath = join(workspaceRoot, ".agent", "providers.json");
  const registry = new ProviderRegistry(keystore, [], undefined, providersPath);
  const bindings = new BindingsStore(workspaceRoot, {}, {
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
    toolContext: { workspaceRoot },
    numCtx: 4096,
    temperature: 0.2,
    audit,
    permissions,
  });
  const server = Bun.serve({
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
      info: { workspaceRoot: workspaceRoot, model: "e2e", numCtx: 4096, version: "0.1.5" },
      bindings,
      registry,
      workspaceRoot,
      dataDir: workspaceRoot,
      brand: new BrandStore(workspaceRoot, {}),
    }).fetch,
  });
  return { server, url: `http://127.0.0.1:${server.port}` };
}

interface World {
  upstream: ReturnType<typeof startUpstream>;
  backend: ReturnType<typeof startBackend>;
  api: (path: string, body?: unknown, method?: "POST" | "PUT") => Promise<Record<string, unknown>>;
  workspace: string;
}

let world: World | null = null;

beforeAll(() => {
  const upstream = startUpstream();
  const workspace = mkdtempSync(join(tmpdir(), "mimon-e2e-"));
  const backend = startBackend(workspace, upstream.url);
  const api = (path: string, body?: unknown, method?: "POST" | "PUT") =>
    fetch(backend.url + path, {
      method: method ?? (body === undefined ? "GET" : "POST"),
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }).then((r) => r.json() as Promise<Record<string, unknown>>);
  world = { upstream, backend, api, workspace };
});

afterAll(() => {
  world?.backend.server.stop(true);
  world?.upstream.server.stop(true);
  if (world) rmSync(world.workspace, { recursive: true, force: true });
});

function runCli(task: string): Promise<{ stdout: string; exitCode: number }> {
  const proc = Bun.spawn([process.execPath, "run", join(import.meta.dir, "..", "bin", "agent.ts"), task], {
    cwd: world!.workspace,
    env: { ...process.env, AGENT_URL: world!.backend.url },
    stdout: "pipe",
    stderr: "pipe",
  });
  return proc.exited.then(async (exitCode) => ({
    stdout: await new Response(proc.stdout).text(),
    exitCode,
  }));
}

describe("onboarding journey: user brings an API key from anywhere", () => {
  it(
    "fresh workspace reports needsSetup and refuses to run",
    async () => {
      const setup = (await world!.api("/setup")) as { needsSetup: boolean };
      expect(setup.needsSetup).toBe(true);
      const result = await runCli("salam");
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain("no provider connected");
    },
    30000,
  );

  it(
    "adds an OpenAI-compatible provider with a loopback URL",
    async () => {
      const added = await world!.api("/providers", {
        name: "mockmind",
        kind: "openai",
        baseUrl: world!.upstream.url,
        models: ["mock-large"],
      });
      expect(added["ok"]).toBe(true);
      const providers = ((await world!.api("/providers")) as { providers: Array<{ name: string; keySet: boolean }> }).providers;
      expect(providers.find((p) => p.name === "mockmind")?.keySet).toBe(false);
    },
    10000,
  );

  it(
    "rejects a wrong key with the upstream error, then accepts the good one",
    async () => {
      const bad = await world!.api("/providers/mockmind/key", { key: "sk-wrong" }, "PUT");
      expect(bad["ok"]).toBe(true);
      const badTest = (await world!.api("/providers/mockmind/test", { model: "mock-large" })) as { ok: boolean; error?: string };
      expect(badTest.ok).toBe(false);
      expect(badTest.error ?? "").toContain("401");

      const good = await world!.api("/providers/mockmind/key", { key: GOOD_KEY }, "PUT");
      expect(good["ok"]).toBe(true);
      const goodTest = (await world!.api("/providers/mockmind/test", { model: "mock-large" })) as { ok: boolean; error?: string };
      expect(goodTest.ok).toBe(true);
      const call = world!.upstream.calls.at(-1)!;
      expect(call.auth).toBe("Bearer " + GOOD_KEY);
      expect(call.model).toBe("mock-large");
    },
    15000,
  );

  it(
    "binding the provider to the tiers clears needsSetup",
    async () => {
      for (const role of ["mimon1", "mimon2", "mimon3", "mimonMax"]) {
        const bound = await world!.api(`/models/${role}`, { binding: "mockmind/mock-large" }, "PUT");
        expect(bound["ok"]).toBe(true);
      }
      const setup = (await world!.api("/setup")) as { needsSetup: boolean };
      expect(setup.needsSetup).toBe(false);
    },
    10000,
  );

  it(
    "the real CLI answers through the provider the user connected",
    async () => {
      const result = await runCli("salam");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Labas khouya — mock provider jawab.");
      const call = world!.upstream.calls.find((c) => c.userText.includes("salam"));
      expect(call).toBeDefined();
      expect(call!.auth).toBe("Bearer " + GOOD_KEY);
    },
    30000,
  );
});

describe("onboarding journey: anthropic-kind provider", () => {
  const ANTH_KEY = "sk-anth-e2e-good";
  let anthUrl = "";
  const anthCalls: Array<{ apiKey: string; version: string; model: string }> = [];

  beforeAll(() => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        if (request.method !== "POST" || !url.pathname.endsWith("/messages")) {
          return Response.json({ error: { message: "unexpected path " + url.pathname } }, { status: 404 });
        }
        const apiKey = request.headers.get("x-api-key") ?? "";
        const version = request.headers.get("anthropic-version") ?? "";
        const body = (await request.json()) as { model: string };
        anthCalls.push({ apiKey, version, model: body.model });
        if (apiKey !== ANTH_KEY) {
          return Response.json({ type: "error", error: { message: "invalid x-api-key" } }, { status: 401 });
        }
        const events = [
          "data: " + JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 15 } } }),
          "data: " + JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text" } }),
          ...["Salam ", "min ", "mockclaude."].map((text) =>
            "data: " + JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }),
          ),
          "data: " + JSON.stringify({ type: "content_block_stop", index: 0 }),
          "data: " + JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } }),
          "data: " + JSON.stringify({ type: "message_stop" }),
        ];
        return new Response(events.join("\n\n") + "\n\n", {
          headers: { "content-type": "text/event-stream" },
        });
      },
    });
    anthUrl = `http://127.0.0.1:${server.port}`;
  });

  it(
    "anthropic-kind provider: add, key, test, bind, and the CLI answers through it",
    async () => {
      const added = await world!.api("/providers", {
        name: "mockclaude",
        kind: "anthropic",
        baseUrl: anthUrl,
        models: ["mock-sonnet"],
      });
      expect(added["ok"]).toBe(true);

      await world!.api("/providers/mockclaude/key", { key: "sk-wrong" }, "PUT");
      const badTest = (await world!.api("/providers/mockclaude/test", { model: "mock-sonnet" })) as { ok: boolean; error?: string };
      expect(badTest.ok).toBe(false);

      await world!.api("/providers/mockclaude/key", { key: ANTH_KEY }, "PUT");
      const goodTest = (await world!.api("/providers/mockclaude/test", { model: "mock-sonnet" })) as { ok: boolean };
      expect(goodTest.ok).toBe(true);
      expect(anthCalls.at(-1)?.apiKey).toBe(ANTH_KEY);
      expect(anthCalls.at(-1)?.version).toBe("2023-06-01");

      const bound = await world!.api("/models/mimon2", { binding: "mockclaude/mock-sonnet" }, "PUT");
      expect(bound["ok"]).toBe(true);

      const result = await runCli("salam claude");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Salam min mockclaude.");
      expect(anthCalls.some((c) => c.model === "mock-sonnet")).toBe(true);
    },
    30000,
  );
});
