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

export const shellExecTool: Tool<typeof inputSchema> = {
  name: "shell.exec",
  description: "Run a shell command in the workspace and return stdout, stderr and exit code",
  permissionClass: "exec",
  schema: inputSchema,
  target: (input) => input.command,
  async invoke(input: z.output<typeof inputSchema>, ctx: ToolContext): Promise<ToolResult> {
    const proc = Bun.spawn(["sh", "-c", input.command], {
      cwd: ctx.workspaceRoot,
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    });
    const abort = () => proc.kill();
    ctx.signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => proc.kill(), input.timeoutMs);

    let stdout = "";
    let stderr = "";
    const readers = [
      new Response(proc.stdout).text().then((t) => (stdout = t)),
      new Response(proc.stderr).text().then((t) => (stderr = t)),
    ];
    const exitCode = await proc.exited;
    clearTimeout(timer);
    ctx.signal?.removeEventListener("abort", abort);
    await Promise.allSettled(readers);

    return exitCode === 0
      ? { ok: true, data: { command: input.command, exitCode, stdout: cap(stdout), stderr: cap(stderr) } }
      : {
          ok: false,
          error: "command failed with exit code " + exitCode,
          data: { command: input.command, exitCode, stdout: cap(stdout), stderr: cap(stderr) },
        };
  },
};
