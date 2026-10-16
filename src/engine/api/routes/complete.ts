import { Hono } from "hono";
import { z } from "zod";
import type { ModelRouter } from "../../models/router";
import type { StreamChunk } from "../../models/types";

const MAX_SYSTEM_CHARS = 16_000;
const MAX_MESSAGE_CHARS = 64_000;
const MAX_MESSAGES = 20;

export interface CompleteSettings {
  router: ModelRouter;
  numCtx: number;
  temperature: number;
}

type CompleteEvent =
  | { type: "model"; name: string }
  | Exclude<StreamChunk, { type: "tool_call" }>
  | { type: "error"; message: string };

const completeBody = z.object({
  role: z.enum(["general", "mimon1", "mimon2", "mimon3", "mimonMax"]).default("mimon2"),
  system: z.string().min(1).max(MAX_SYSTEM_CHARS),
  messages: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string().min(1).max(MAX_MESSAGE_CHARS),
      }),
    )
    .min(1)
    .max(MAX_MESSAGES)
    .refine((messages) => messages.at(-1)?.role === "user", "the last message must come from the user"),
});

export function createCompleteRoute(settings: CompleteSettings): Hono {
  const route = new Hono();
  route.post("/", async (c) => {
    const parsed = completeBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ ok: false, error: parsed.error.message }, 400);
    }
    const { role, system, messages } = parsed.data;
    let binding;
    try {
      binding = settings.router.resolve(role);
    } catch (error) {
      return c.json({ ok: false, error: (error as Error).message }, 503);
    }
    const signal = c.req.raw.signal;
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (event: CompleteEvent) => controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
        send({ type: "model", name: `${binding.providerName}/${binding.model}` });
        try {
          const chunks = binding.provider.complete(
            {
              model: binding.model,
              messages: [{ role: "system", content: system }, ...messages],
              numCtx: settings.numCtx,
              temperature: settings.temperature,
            },
            signal,
          );
          for await (const chunk of chunks) {
            if (chunk.type !== "tool_call") send(chunk);
          }
        } catch (error) {
          if (!signal.aborted) send({ type: "error", message: (error as Error).message });
        }
        controller.close();
      },
    });
    return new Response(stream, { headers: { "content-type": "application/x-ndjson" } });
  });
  return route;
}
