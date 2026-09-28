import { Hono } from "hono";
import { z } from "zod";
import { sniffImageMime, stripDataUrl } from "../../../shared/images";
import type { Db } from "../../db/client";
import { Agent, SessionNotFoundError, TurnError } from "../../core/agent/agent";
import { PendingPermissions } from "../../core/permissions/pending";
import type { StreamRegistry } from "../ws/agent-stream";

export function createAgentRoute(
  agent: Agent,
  streams: StreamRegistry,
  pending: PendingPermissions,
  db: Db,
): Hono {
  const route = new Hono();
  const runBody = z.object({
    sessionId: z.string().min(1),
    task: z.string().min(1),
    role: z.enum(["coder", "general", "mimon1", "mimon2", "mimon3", "mimonMax"]).default("coder"),
    images: z
      .array(
        z
          .string()
          .max(8 * 1024 * 1024)
          .refine((value) => sniffImageMime(value) !== null, "unsupported image data"),
      )
      .max(4)
      .optional()
      .transform((images) => images?.map(stripDataUrl)),
  });
  const abortBody = z
    .object({ taskId: z.string().min(1).optional(), sessionId: z.string().min(1).optional() })
    .refine((value) => Boolean(value.taskId || value.sessionId), {
      message: "taskId or sessionId is required",
    });

  route.post("/run", async (c) => {
    const parsed = runBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ ok: false, error: parsed.error.message }, 400);
    }
    const { sessionId, task, role, images } = parsed.data;
    const stream = streams.get(sessionId);
    try {
      const publish = (type: string, payload: unknown) => stream.publish(type, payload);
      const result = await agent.runTask(sessionId, task, role, publish, images);
      db.query(
        "UPDATE sessions SET title = ? WHERE id = ? AND (title IS NULL OR title = 'cli chat')",
      ).run(task.slice(0, 60), sessionId);
      return c.json({
        ok: true,
        taskId: result.taskId,
        answer: result.answer,
        steps: result.steps,
        usage: result.usage,
      });
    } catch (error) {
      if (error instanceof SessionNotFoundError) {
        return c.json({ ok: false, error: error.message }, 404);
      }
      if (error instanceof TurnError) {
        return c.json({ ok: false, taskId: error.taskId, error: error.message }, error.status);
      }
      const message = error instanceof Error ? error.message : "turn failed";
      return c.json({ ok: false, error: message }, 500);
    }
  });

  route.post("/abort", async (c) => {
    const parsed = abortBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ ok: false, error: parsed.error.message }, 400);
    }
    const aborted = parsed.data.sessionId
      ? agent.abortSession(parsed.data.sessionId)
      : agent.abortTask(parsed.data.taskId as string);
    return c.json({ ok: aborted, aborted });
  });

  const resolvePermission = (requestId: string, approved: boolean, sessionId: string) => {
    const resolved = pending.resolve(requestId, approved);
    if (resolved) {
      streams.get(sessionId).publish("permission.resolved", {
        requestId,
        approved,
      });
    }
    return { ok: resolved, requestId, approved };
  };

  route.post("/permissions/:requestId", async (c) => {
    const requestId = c.req.param("requestId");
    const body = z.object({ approved: z.boolean(), sessionId: z.string().min(1) });
    const parsed = body.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ ok: false, error: parsed.error.message }, 400);
    }
    return c.json(resolvePermission(requestId, parsed.data.approved, parsed.data.sessionId));
  });

  route.post("/permissions", async (c) => {
    const body = z.object({
      requestId: z.string().min(1),
      approved: z.boolean(),
      sessionId: z.string().min(1),
    });
    const parsed = body.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ ok: false, error: parsed.error.message }, 400);
    }
    return c.json(resolvePermission(parsed.data.requestId, parsed.data.approved, parsed.data.sessionId));
  });

  return route;
}
