import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import type { AuditWriter } from "../../core/audit/audit";
import { RUNNABLE_ROLES, type BindingsStore } from "../../models/bindings";
import type { ProviderRegistry } from "../../models/registry";

const MARKER = "onboarded";

export interface SetupStatus {
  needsSetup: boolean;
}

export function setupDone(bindings: BindingsStore, registry: ProviderRegistry, workspaceRoot: string): boolean {
  const hasKey = registry.list().some((provider) => provider.keySet);
  const customBinding = RUNNABLE_ROLES.some((role) => bindings.source(role) !== "default");
  const marker = existsSync(join(workspaceRoot, ".agent", MARKER));
  return hasKey || customBinding || marker;
}

export function createSetupRoute(
  bindings: BindingsStore,
  registry: ProviderRegistry,
  workspaceRoot: string,
  audit: AuditWriter,
): Hono {
  const route = new Hono();
  route.get("/", (c) => {
    return c.json({ ok: true, needsSetup: !setupDone(bindings, registry, workspaceRoot) });
  });
  route.post("/skip", async (c) => {
    const dir = join(workspaceRoot, ".agent");
    mkdirSync(dir, { recursive: true });
    await Bun.write(join(dir, MARKER), JSON.stringify({ skippedAt: new Date().toISOString() }) + "\n");
    audit.write("setup.skipped", {});
    return c.json({ ok: true });
  });
  return route;
}
