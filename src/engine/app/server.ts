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
  hostname?: string;
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

const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1"]);

function hostnameFromHeader(header: string): string {
  const value = header.trim().toLowerCase();
  if (value.startsWith("[")) {
    const end = value.indexOf("]");
    return end === -1 ? value : value.slice(1, end);
  }
  if ((value.match(/:/g) ?? []).length > 1) return value;
  const colon = value.indexOf(":");
  return colon === -1 ? value : value.slice(0, colon);
}

function originHostname(origin: string): string {
  try {
    return new URL(origin).hostname.toLowerCase();
  } catch {
    return "";
  }
}

export function createServer(deps: ServerDeps): Hono {
  const app = new Hono();
  const configured = (deps.hostname ?? "127.0.0.1").trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (configured === "" || configured === "0.0.0.0" || configured === "::") {
    throw new Error("the engine refuses wildcard binds — the control API is unauthenticated by design and must stay on loopback");
  }
  const allowedHosts = new Set(LOCAL_HOSTNAMES);
  allowedHosts.add(configured);
  app.use("*", async (c, next) => {
    const hostHeader = c.req.header("host");
    if (hostHeader !== undefined && !allowedHosts.has(hostnameFromHeader(hostHeader))) {
      return c.json({ ok: false, error: "forbidden host" }, 403);
    }
    const origin = c.req.header("origin");
    if (origin !== undefined) {
      const hostname = originHostname(origin);
      if (!LOCAL_HOSTNAMES.has(hostname)) {
        return c.json({ ok: false, error: "forbidden origin" }, 403);
      }
    }
    await next();
  });
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
