import { Hono } from "hono";
import type { Db } from "../../db/client";

export interface HealthInfo {
  model: string;
  numCtx: number;
  version: string;
  workspaceRoot: string;
}

export function createHealthRoute(db: Db, info: HealthInfo): Hono {
  const route = new Hono();
  route.get("/", (c) => {
    db.query("SELECT 1 AS ok").get();
    return c.json({ ok: true, service: "agent-backend", version: info.version, model: info.model, numCtx: info.numCtx, workspaceRoot: info.workspaceRoot });
  });
  return route;
}
