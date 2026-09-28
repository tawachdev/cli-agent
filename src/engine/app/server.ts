import { Hono } from "hono";
import { createAgentRoute } from "../api/routes/agent";
import { createBrandRoute } from "../api/routes/brand";
import { createHealthRoute } from "../api/routes/health";
import { createModelsRoute } from "../api/routes/models";
import { createProvidersRoute } from "../api/routes/providers";
import { createSessionsRoute } from "../api/routes/sessions";
import { createSetupRoute } from "../api/routes/setup";
import { upgradeWebSocket, type StreamRegistry } from "../api/ws/agent-stream";
import type { Agent } from "../core/agent/agent";
import type { AuditWriter } from "../core/audit/audit";
import { PendingPermissions } from "../core/permissions/pending";
import type { Db } from "../db/client";
import type { BrandStore } from "../brand";
import type { BindingsStore } from "../models/bindings";
import type { ProviderRegistry } from "../models/registry";
import type { Logger } from "../shared/logger";

export interface ServerDeps {
  db: Db;
  logger: Logger;
  agent: Agent;
  streams: StreamRegistry;
  pending: PendingPermissions;
  audit: AuditWriter;
  info: { model: string; numCtx: number; version: string };
  bindings: BindingsStore;
  registry: ProviderRegistry;
  workspaceRoot: string;
  dataDir: string;
  brand: BrandStore;
}

export function createServer(deps: ServerDeps): Hono {
  const app = new Hono();
  app.get("/", (c) => c.json({ ok: true, service: "agent-backend" }));
  app.route("/health", createHealthRoute(deps.db, deps.info));
  app.route("/models", createModelsRoute(deps.bindings, deps.registry, deps.audit));
  app.route("/providers", createProvidersRoute(deps.registry, deps.audit));
  app.route("/setup", createSetupRoute(deps.bindings, deps.registry, deps.workspaceRoot, deps.audit));
  app.route("/brand", createBrandRoute(deps.brand, deps.audit));
  app.route("/sessions", createSessionsRoute(deps.db, deps.pending, deps.streams));
  app.route("/agent", createAgentRoute(deps.agent, deps.streams, deps.pending, deps.db));
  app.get(
    "/sessions/:id/stream",
    upgradeWebSocket((c) => {
      const sessionId = c.req.param("id") ?? "";
      const since = Number(c.req.query("since") ?? "0") || 0;
      let unsubscribe: (() => void) | undefined;
      return {
        onOpen(_event, ws) {
          if (!sessionId) return;
          unsubscribe = deps.streams.get(sessionId).subscribe(
            (event) => {
              ws.send(JSON.stringify(event));
            },
            since,
          );
        },
        onClose() {
          unsubscribe?.();
        },
      };
    }),
  );
  app.onError((error, c) => {
    deps.logger.error("request failed", {
      path: c.req.path,
      error: error.message,
    });
    return c.json({ ok: false, error: "internal_error" }, 500);
  });
  return app;
}
