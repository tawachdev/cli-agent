import { z } from "zod";
import type { Tool, ToolContext, ToolResult } from "../types";

const MAX_OUTPUT_BYTES = 32 * 1024;
const DEFAULT_TIMEOUT_MS = 120_000;

const inputSchema = z.object({
  command: z.string().min(1),
  timeoutMs: z.number().int().min(1000).max(600_000).default(DEFAULT_TIMEOUT_MS),
});

function cap(text: string): string {
  return text.length > MAX_OUTPUT_BYTES ? text.slice(0, MAX_OUTPUT_BYTES) + "\n... (truncated)" : text;
}

async function readCapped(stream: ReadableStream<Uint8Array>, buf: { text: string }): Promise<void> {
  const decoder = new TextDecoder();
  for await (const chunk of stream) {
    if (buf.text.length < MAX_OUTPUT_BYTES) {
      buf.text += decoder.decode(chunk, { stream: true });
    }
  }
  buf.text += decoder.decode();
}

export const shellExecTool: Tool<typeof inputSchema> = {
  name: "shell.exec",
  description: "Run a shell command in the workspace and return stdout, stderr and exit code",
  permissionClass: "exec",
  schema: inputSchema,
  target: (input) => input.command,
  async invoke(input: z.output<typeof inputSchema>, ctx: ToolContext): Promise<ToolResult> {
    if (ctx.signal?.aborted) {
      return { ok: false, error: "command aborted before start", data: { command: input.command } };
    }
    const proc = Bun.spawn(["sh", "-c", input.command], {
      cwd: ctx.workspaceRoot,
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
      timeout: input.timeoutMs,
      killSignal: "SIGKILL",
    });
    let escalated = false;
    const terminate = () => {
      if (escalated) return;
      escalated = true;
      proc.kill();
      setTimeout(() => {
        if (proc.exitCode === null) proc.kill("SIGKILL");
      }, 2000).unref?.();
    };
    ctx.signal?.addEventListener("abort", terminate, { once: true });

    const out = { text: "" };
    const err = { text: "" };
    const readers = [readCapped(proc.stdout, out), readCapped(proc.stderr, err)];
    try {
      const exitCode = await proc.exited;
      await Promise.allSettled(readers);

      if (ctx.signal?.aborted) {
        return { ok: false, error: "command aborted", data: { command: input.command } };
      }
      return exitCode === 0
        ? { ok: true, data: { command: input.command, exitCode, stdout: cap(out.text), stderr: cap(err.text) } }
        : {
            ok: false,
            error: "command failed with exit code " + exitCode,
            data: { command: input.command, exitCode, stdout: cap(out.text), stderr: cap(err.text) },
          };
    } finally {
      ctx.signal?.removeEventListener("abort", terminate);
    }
  },
};
