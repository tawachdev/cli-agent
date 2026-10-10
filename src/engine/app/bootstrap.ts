import { loadConfig } from "./config";
import { PRODUCT_VERSION } from "../../shared/version";
import { createServer } from "./server";
import { createLogger } from "../shared/logger";
import { tmpdir } from "node:os";
import { homedir } from "node:os";
import { join } from "node:path";
import { openDb } from "../db/client";
import { runMigrations } from "../db/migrate";
import { migrations } from "../db/migrations";
import { ModelRouter } from "../models/router";
import { KeychainKeyStore } from "../models/keystore";
import { loadExtraProviders, ProviderRegistry } from "../models/registry";
import { BindingsStore, RUNNABLE_ROLES, type RunnableRole } from "../models/bindings";
import type { StreamChunk } from "../models/types";
import type { ModelBinding } from "../models/router";
import type { ModelRole } from "../models/types";
import { ToolRegistry } from "../tools/registry";
import { fsReadTool } from "../tools/fs/read";
import { fsListTool } from "../tools/fs/list";
import { fsWriteTool, fsEditTool } from "../tools/fs/write";
import { grepTool } from "../tools/search/grep";
import { gitStatusTool } from "../tools/git/status";
import { gitDiffTool } from "../tools/git/diff";
import { shellExecTool } from "../tools/shell/exec";
import { createVisionTool } from "../tools/computer/vision";
import { Agent } from "../core/agent/agent";
import { SqliteAudit } from "../core/audit/audit";
import { PermissionEngine } from "../core/permissions/engine";
import { PendingPermissions } from "../core/permissions/pending";
import { loadPolicy } from "../core/permissions/policy";
import { loadPluginRoots } from "../plugins/loader";
import { StreamRegistry, websocket } from "../api/ws/agent-stream";
import { dirname } from "node:path";
import { BrandStore } from "../brand";

const config = loadConfig();
const logger = createLogger(config.logLevel);
const db = openDb(config.dbPath);
runMigrations(db, migrations);

const audit = new SqliteAudit(db);
const pending = new PendingPermissions();
const policy = loadPolicy(config.workspaceRoot);
const permissions = new PermissionEngine(policy, pending, audit);

const keystore = new KeychainKeyStore();
const providersPath = join(config.workspaceRoot, ".agent", "providers.json");
const extraProviders = await loadExtraProviders(providersPath);
const registry = new ProviderRegistry(keystore, extraProviders, undefined, providersPath);
const bindings = new BindingsStore(config.workspaceRoot, process.env, {
  coder: config.models.coder,
  general: config.models.general,
  mimon1: config.models.mimon1,
  mimon2: config.models.mimon2,
  mimon3: config.models.mimon3,
  mimonMax: config.models.mimonMax,
});
const router = new ModelRouter((role: ModelRole) => {
  const binding = RUNNABLE_ROLES.includes(role as RunnableRole)
    ? bindings.get(role as RunnableRole)
    : role === "vision"
      ? config.models.vision
      : config.models.coder;
  return registry.resolve(binding);
});
const unboundRoles = RUNNABLE_ROLES.filter((role) => bindings.source(role) === "default");
if (unboundRoles.length > 0) {
  const keyed = registry.list().filter((provider) => provider.keySet && provider.models.length > 0);
  let chosen: (typeof keyed)[number] | undefined;
  for (const provider of keyed) {
    try {
      const { provider: probed } = registry.resolve(`${provider.name}/${provider.models[0]!}`);
      const stream: AsyncIterator<StreamChunk> = probed.complete(
        {
          model: provider.models[0]!,
          messages: [{ role: "user", content: "ping" }],
          numCtx: 512,
          temperature: 0,
        },
        AbortSignal.timeout(5000),
      )[Symbol.asyncIterator]();
      const first = await stream.next();
      if (!first.done) {
        chosen = provider;
        break;
      }
    } catch {
      continue;
    }
  }
  if (!chosen && keyed.length > 0) chosen = keyed[0];
  if (chosen) {
    for (const role of unboundRoles) await bindings.set(role, `${chosen.name}/${chosen.models[0]!}`);
    logger.info("auto-bound unbound roles after live probe", { provider: chosen.name, roles: unboundRoles });
  }
}
const failover = (role: ModelRole, failed: ModelBinding, reason: string): ModelBinding | null => {
  if (!/\b401\b|\b403\b|\b503\b|Unable to connect|ECONNREFUSED|fetch failed|high demand/i.test(reason)) return null;
  const candidates = registry.list().filter((provider) => provider.keySet && provider.models.length > 0);
  const idx = candidates.findIndex((provider) => provider.name === failed.providerName);
  const ordered = idx >= 0 ? [...candidates.slice(idx + 1), ...candidates.slice(0, idx + 1)] : candidates;
  const runnable = RUNNABLE_ROLES.includes(role as RunnableRole) ? (role as RunnableRole) : null;
  for (const candidate of ordered) {
    const binding = `${candidate.name}/${candidate.models[0]!}`;
    const resolved = registry.resolve(binding);
    if (resolved.providerName === failed.providerName) continue;
    if (runnable) void bindings.set(runnable, binding);
    logger.info("provider failover", { role, binding, reason: reason.slice(0, 80) });
    return resolved;
  }
  return null;
};
const tools = new ToolRegistry(permissions);
tools.register(fsReadTool);
tools.register(fsListTool);
tools.register(fsWriteTool);
tools.register(fsEditTool);
tools.register(grepTool);
tools.register(gitStatusTool);
tools.register(gitDiffTool);
tools.register(shellExecTool);
tools.register(createVisionTool(router, config.numCtx, tmpdir()));
const allowWorkspacePlugins = (process.env.AGENT_PLUGINS ?? "")
  .split(",")
  .map((value) => value.trim())
  .includes("workspace");
const plugins = await loadPluginRoots(
  [
    { dir: join(config.workspaceRoot, ".agent", "plugins"), trust: "workspace" },
    { dir: join(homedir(), ".agent", "plugins"), trust: "trusted" },
  ],
  tools,
  logger,
  { allowWorkspace: allowWorkspacePlugins },
);
for (const plugin of plugins) {
  logger.info("plugin loaded", { ...plugin });
}
const brandStore = new BrandStore(config.workspaceRoot, process.env);
const agent = new Agent({
  agentName: () => brandStore.effective().name,
  db,
  router,
  failover,
  tools,
  toolContext: { workspaceRoot: config.workspaceRoot },
  numCtx: config.numCtx,
  temperature: config.temperature,
  audit,
  permissions,
  checkCommand: config.checkCommand,
});
const streams = new StreamRegistry();
const dataDir = dirname(config.dbPath);

const server = Bun.serve({
  fetch: createServer({
    db,
    logger,
    hostname: config.hostname,
    agent,
    streams,
    pending,
    audit,
    info: {
      model: registry.splitBinding(bindings.get("mimon2")).def ? bindings.get("mimon2") : "not connected (/setup)",
      numCtx: config.numCtx,
      workspaceRoot: config.workspaceRoot,
      version: PRODUCT_VERSION,
    },
    bindings,
    registry,
    workspaceRoot: config.workspaceRoot,
    dataDir,
    brand: brandStore,
  }).fetch,
  websocket,
  port: config.port,
  hostname: config.hostname,
  idleTimeout: 255,
});

logger.info("backend listening", {
  url: `http://${config.hostname}:${config.port}`,
  db: config.dbPath,
  activeModel: registry.splitBinding(bindings.get("mimon2")).def ? bindings.get("mimon2") : "not connected (/setup)",
  workspaceRoot: config.workspaceRoot,
  numCtx: config.numCtx,
  tools: tools.list().length,
  providers: registry.list().length,
  name: "mimon",
});

const shutdown = (): void => {
  server.stop(true);
  db.close();
  logger.info("backend stopped");
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
if (process.ppid > 1) {
  setInterval(() => {
    if (process.ppid === 1) shutdown();
  }, 2000);
  process.on("disconnect", shutdown);
}
