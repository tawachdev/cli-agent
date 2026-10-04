import { readFile, stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import type { Tool } from "../types";
import { scopedPath } from "../../shared/paths";

const MAX_MATCHES = 100;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_FILES_SCANNED = 2000;
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "data", ".venv", "__pycache__"]);

const inputSchema = z.object({
  pattern: z.string().min(1),
  glob: z.string().default("**/*"),
});

export const grepTool: Tool<typeof inputSchema> = {
  name: "search.grep",
  description: "Search file contents for a text pattern (case-insensitive) across the workspace",
  permissionClass: "read",
  schema: inputSchema,
  target: (input) => input.pattern,
  async invoke(input, ctx) {
    const root = scopedPath(ctx.workspaceRoot, ".");
    if (!root) {
      return { ok: false, error: "workspace root is not a contained directory" };
    }
    const glob = new Bun.Glob(input.glob);
    const matches: Array<{ file: string; line: number; text: string }> = [];
    const needle = input.pattern.toLowerCase();
    let scanned = 0;
    let visited = 0;
    let truncated = false;

    for await (const rel of glob.scan({ cwd: root, onlyFiles: true, dot: true })) {
      if (matches.length >= MAX_MATCHES) {
        truncated = true;
        break;
      }
      const parts = rel.split(sep);
      if (parts.some((part) => SKIP_DIRS.has(part))) {
        visited++;
        if (visited >= MAX_FILES_SCANNED) {
          truncated = true;
          break;
        }
        continue;
      }
      if (visited >= MAX_FILES_SCANNED) {
        truncated = true;
        break;
      }
      const abs = scopedPath(ctx.workspaceRoot, rel);
      if (!abs) continue;
      const info = await stat(abs).catch(() => null);
      if (!info?.isFile() || info.size > MAX_FILE_BYTES) continue;
      scanned++;
      visited++;
      const content = await readFile(abs, "utf8").catch(() => null);
      if (content === null) continue;
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (lines[i]?.toLowerCase().includes(needle)) {
          matches.push({ file: relative(root, abs), line: i + 1, text: (lines[i] ?? "").trim().slice(0, 200) });
          if (matches.length >= MAX_MATCHES) {
            truncated = true;
            break;
          }
        }
      }
    }
    return { ok: true, data: { pattern: input.pattern, matches, truncated, filesScanned: scanned } };
  },
};
