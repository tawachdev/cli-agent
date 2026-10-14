import { z } from "zod";
import { guard, readCapped, spawnShell } from "../../shared/proc";
import type { Tool, ToolContext, ToolResult } from "../types";

const MAX_OUTPUT_BYTES = 32 * 1024;
const DEFAULT_TIMEOUT_MS = 120_000;

const inputSchema = z.object({
  command: z.string().min(1),
  timeoutMs: z.number().int().min(1000).max(600_000).default(DEFAULT_TIMEOUT_MS),
});

function cap(capped: { text: string; truncated: boolean }): string {
  return capped.truncated ? capped.text + "\n... (truncated)" : capped.text;
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
    const proc = spawnShell(input.command, ctx.workspaceRoot);
    const stop = guard(proc, ctx.signal, input.timeoutMs);
    try {
      const [stdout, stderr, exitCode] = await Promise.all([
        readCapped(proc.stdout, MAX_OUTPUT_BYTES),
        readCapped(proc.stderr, MAX_OUTPUT_BYTES),
        proc.exited,
      ]);
      const data = { command: input.command, exitCode, stdout: cap(stdout), stderr: cap(stderr) };
      if (ctx.signal?.aborted) {
        return { ok: false, error: "command aborted", data: { command: input.command } };
      }
      if (stop.timedOut()) {
        return { ok: false, error: "command timed out after " + input.timeoutMs + " ms", data };
      }
      return exitCode === 0 ? { ok: true, data } : { ok: false, error: "command failed with exit code " + exitCode, data };
    } finally {
      stop.release();
    }
  },
};
