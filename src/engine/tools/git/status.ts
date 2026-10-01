import { z } from "zod";
import { runProc } from "../../shared/proc";
import type { Tool } from "../types";

const inputSchema = z.object({});

export const gitStatusTool: Tool<typeof inputSchema> = {
  name: "git.status",
  description: "Show the working tree status of the workspace git repository",
  permissionClass: "read",
  schema: inputSchema,
  target: () => "git status",
  async invoke(_input, ctx) {
    if (ctx.signal?.aborted) {
      return { ok: false, error: "aborted before start" };
    }
    const proc = await runProc(["git", "status", "--porcelain", "--branch"], {
      cwd: ctx.workspaceRoot,
      signal: ctx.signal,
    });
    const out = proc.stdout.trim();
    if (proc.exitCode !== 0) {
      return { ok: false, error: proc.stderr.trim().slice(0, 500) || "git status failed" };
    }
    return { ok: true, data: { status: out || "clean" } };
  },
};
