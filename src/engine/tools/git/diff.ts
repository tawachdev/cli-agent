import { z } from "zod";
import type { Tool } from "../types";

const inputSchema = z.object({
  staged: z.boolean().default(false),
});

export const gitDiffTool: Tool<typeof inputSchema> = {
  name: "git.diff",
  description: "Show the current uncommitted diff of the workspace git repository",
  permissionClass: "read",
  schema: inputSchema,
  target: (input) => (input.staged ? "git diff --staged" : "git diff"),
  async invoke(input, ctx) {
    const proc = input.staged
      ? Bun.spawnSync(["git", "diff", "--staged"], { cwd: ctx.workspaceRoot, stdout: "pipe", stderr: "pipe" })
      : Bun.spawnSync(["git", "diff"], { cwd: ctx.workspaceRoot, stdout: "pipe", stderr: "pipe" });
    const out = proc.stdout.toString();
    if (proc.exitCode !== 0) {
      return { ok: false, error: proc.stderr.toString().trim().slice(0, 500) || "git diff failed" };
    }
    return {
      ok: true,
      data: { diff: out.length > 32 * 1024 ? out.slice(0, 32 * 1024) + "\n... (truncated)" : out || "(empty diff)" },
    };
  },
};
