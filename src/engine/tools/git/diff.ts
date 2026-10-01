import { z } from "zod";
import { runProc } from "../../shared/proc";
import type { Tool } from "../types";

const MAX_DIFF_BYTES = 32 * 1024;

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
    if (ctx.signal?.aborted) {
      return { ok: false, error: "aborted before start" };
    }
    const args = input.staged ? ["git", "diff", "--staged"] : ["git", "diff"];
    const proc = await runProc(args, { cwd: ctx.workspaceRoot, signal: ctx.signal });
    const out = proc.stdout;
    if (proc.exitCode !== 0) {
      return { ok: false, error: proc.stderr.trim().slice(0, 500) || "git diff failed" };
    }
    return {
      ok: true,
      data: {
        diff: out.length > MAX_DIFF_BYTES ? out.slice(0, MAX_DIFF_BYTES) + "\n... (truncated)" : out || "(empty diff)",
      },
    };
  },
};
