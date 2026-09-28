import { Hono } from "hono";
import { z } from "zod";
import type { Db } from "../../db/client";
import { appendMessage, createSession, getSession, listMessages } from "../../core/agent/state";
import { PendingPermissions } from "../../core/permissions/pending";
import type { StreamRegistry } from "../ws/agent-stream";

export function createSessionsRoute(
  db: Db,
  pending: PendingPermissions,
  streams: StreamRegistry,
): Hono {
  const route = new Hono();
  const createBody = z.object({ title: z.string().min(1).max(200).optional() });

  route.get("/", (c) => {
    const rows = db
      .query(
        "SELECT s.id, s.title, s.created_at, s.updated_at, (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id) AS messages FROM sessions s ORDER BY s.updated_at DESC LIMIT 50",
      )
      .all() as Array<Record<string, unknown>>;
    return c.json({ ok: true, sessions: rows });
  });

  route.patch("/:id", async (c) => {
    const id = c.req.param("id");
    const body = z.object({ title: z.string().min(1).max(200) });
    const parsed = body.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ ok: false, error: "invalid body" }, 400);
    }
    if (!getSession(db, id)) {
      return c.json({ ok: false, error: "session not found" }, 404);
    }
    db.query("UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?").run(
      parsed.data.title,
      new Date().toISOString(),
      id,
    );
    return c.json({ ok: true, title: parsed.data.title });
  });

  route.post("/", async (c) => {
    const parsed = createBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      return c.json({ ok: false, error: "invalid body" }, 400);
    }
    const session = createSession(db, parsed.data.title ?? null);
    return c.json({ ok: true, session }, 201);
  });

  route.get("/:id", (c) => {
    const session = getSession(db, c.req.param("id"));
    if (!session) {
      return c.json({ ok: false, error: "session not found" }, 404);
    }
    return c.json({ ok: true, session });
  });

  route.get("/:id/messages", (c) => {
    const id = c.req.param("id");
    if (!getSession(db, id)) {
      return c.json({ ok: false, error: "session not found" }, 404);
    }
    return c.json({ ok: true, messages: listMessages(db, id) });
  });

  route.post("/:id/messages", async (c) => {
    const id = c.req.param("id");
    if (!getSession(db, id)) {
      return c.json({ ok: false, error: "session not found" }, 404);
    }
    const body = z.object({ role: z.enum(["user", "system"]), content: z.string().min(1) });
    const parsed = body.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ ok: false, error: "invalid body" }, 400);
    }
    appendMessage(db, { sessionId: id, role: parsed.data.role, content: parsed.data.content });
    return c.json({ ok: true }, 201);
  });

  route.get("/:id/audit", (c) => {
    const id = c.req.param("id");
    if (!getSession(db, id)) {
      return c.json({ ok: false, error: "session not found" }, 404);
    }
    const rows = db
      .query(
        "SELECT id, ts, type, payload FROM audit_events WHERE session_id = ? ORDER BY id DESC LIMIT 100",
      )
      .all(id) as Array<{ id: number; ts: string; type: string; payload: string }>;
    return c.json({
      ok: true,
      events: rows.reverse().map((row) => ({ ...row, payload: JSON.parse(row.payload) as unknown })),
    });
  });

  return route;
}
