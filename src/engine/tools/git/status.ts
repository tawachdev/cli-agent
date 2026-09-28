import { z } from "zod";
import type { Tool } from "../types";

const inputSchema = z.object({});

export const gitStatusTool: Tool<typeof inputSchema> = {
  name: "git.status",
  description: "Show the working tree status of the workspace git repository",
  permissionClass: "read",
  schema: inputSchema,
  target: () => "git status",
  async invoke(_input, ctx) {
    const proc = Bun.spawnSync(["git", "status", "--porcelain", "--branch"], {
      cwd: ctx.workspaceRoot,
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = proc.stdout.toString().trim();
    if (proc.exitCode !== 0) {
      return { ok: false, error: proc.stderr.toString().trim().slice(0, 500) || "git status failed" };
    }
    return { ok: true, data: { status: out || "clean" } };
  },
};
