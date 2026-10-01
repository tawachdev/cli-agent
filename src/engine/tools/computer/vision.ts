import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { ModelRouter } from "../../models/router";
import type { Tool } from "../types";

const inputSchema = z.object({
  question: z.string().min(1).default("Describe what is visible on the screen."),
});

export function createVisionTool(router: ModelRouter, numCtx: number, tmpDir: string): Tool<typeof inputSchema> {
  return {
    name: "computer.vision",
    description: "Take a screenshot of the screen and analyze it with the vision model",
    permissionClass: "exec",
    schema: inputSchema,
    target: () => "screencapture + vision analysis",
    async invoke(input, ctx) {
      if (ctx.signal?.aborted) {
        return { ok: false, error: "aborted before start" };
      }
      const shotPath = join(tmpDir, "agent-screen-" + randomUUID() + ".png");
      try {
        const proc = Bun.spawn(["screencapture", "-x", shotPath], { stdout: "ignore", stderr: "pipe" });
        const exitCode = await proc.exited;
        if (exitCode !== 0) {
          return { ok: false, error: "screencapture failed with exit code " + exitCode };
        }
        const image = await readFile(shotPath, "base64").catch(() => null);
        if (!image) return { ok: false, error: "screenshot file not readable" };
        const binding = router.resolve("vision");
        let answer = "";
        for await (const chunk of binding.provider.complete(
          {
            model: binding.model,
            messages: [{ role: "user", content: input.question, images: [image] }],
            numCtx,
            temperature: 0.2,
          },
          ctx.signal,
        )) {
          if (chunk.type === "token") answer += chunk.text;
        }
        return { ok: true, data: { analysis: answer.trim() } };
      } finally {
        await rm(shotPath, { force: true }).catch(() => undefined);
      }
    },
  };
}
