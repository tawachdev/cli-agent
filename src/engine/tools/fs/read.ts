import { readFile, stat } from "node:fs/promises";
import { z } from "zod";
import { scopedPath } from "../../shared/paths";
import type { Tool } from "../types";

const MAX_BYTES = 256 * 1024;

const inputSchema = z.object({
  path: z.string().min(1),
});

export const fsReadTool: Tool<typeof inputSchema> = {
  name: "fs.read",
  description: "Read a text file from the workspace and return its content",
  permissionClass: "read",
  schema: inputSchema,
  target: (input) => input.path,
  async invoke(input, ctx) {
    const target = scopedPath(ctx.workspaceRoot, input.path);
    if (!target) return { ok: false, error: "path outside workspace: " + input.path };
    const info = await stat(target).catch(() => null);
    if (!info?.isFile()) {
      return { ok: false, error: "not a file: " + input.path };
    }
    if (info.size > MAX_BYTES) {
      return { ok: false, error: `file too large (${info.size} bytes, max ${MAX_BYTES})` };
    }
    const content = await readFile(target, "utf8");
    return { ok: true, data: { path: input.path, bytes: info.size, content } };
  },
};
