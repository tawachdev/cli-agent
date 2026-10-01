import { readdir, stat } from "node:fs/promises";
import { z } from "zod";
import { scopedPath } from "../../shared/paths";
import type { Tool } from "../types";

const inputSchema = z.object({
  path: z.string().default("."),
});

export const fsListTool: Tool<typeof inputSchema> = {
  name: "fs.list",
  description: "List the files and folders of a workspace directory",
  permissionClass: "read",
  schema: inputSchema,
  target: (input) => input.path,
  async invoke(input, ctx) {
    const target = scopedPath(ctx.workspaceRoot, input.path);
    if (!target) return { ok: false, error: "path outside workspace: " + input.path };
    const info = await stat(target).catch(() => null);
    if (!info?.isDirectory()) {
      return { ok: false, error: "not a directory: " + input.path };
    }
    const entries = await readdir(target, { withFileTypes: true });
    const listed = [];
    for (const entry of entries.slice(0, 500)) {
      const type = entry.isSymbolicLink() ? "link" : entry.isDirectory() ? "dir" : "file";
      listed.push({ name: entry.name, type });
    }
    return { ok: true, data: { path: input.path, entries: listed, truncated: entries.length > 500 } };
  },
};
