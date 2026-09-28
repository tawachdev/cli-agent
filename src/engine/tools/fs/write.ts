import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { lineDiff } from "../../shared/diff";
import { scopedPath } from "../../shared/paths";
import type { Tool } from "../types";

const inputSchema = z.object({
  path: z.string().min(1),
  content: z.string(),
});

export const fsWriteTool: Tool<typeof inputSchema> = {
  name: "fs.write",
  description: "Create or overwrite a text file in the workspace with the given content",
  permissionClass: "write",
  schema: inputSchema,
  target: (input) => input.path,
  preview: (input) =>
    "write " + input.path + " (" + input.content.split("\n").length + " lines)\n" + lineDiff("", input.content),
  async invoke(input, ctx) {
    const target = scopedPath(ctx.workspaceRoot, input.path);
    if (!target) return { ok: false, error: "path outside workspace: " + input.path };
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, input.content, "utf8");
    return { ok: true, data: { path: input.path, bytes: input.content.length } };
  },
};

const editInputSchema = z.object({
  path: z.string().min(1),
  oldText: z.string().min(1),
  newText: z.string(),
  replaceAll: z.boolean().default(false),
});

export const fsEditTool: Tool<typeof editInputSchema> = {
  name: "fs.edit",
  description: "Replace an exact text snippet inside an existing workspace file",
  permissionClass: "write",
  schema: editInputSchema,
  target: (input) => input.path,
  preview: (input) => "edit " + input.path + "\n" + lineDiff(input.oldText, input.newText),
  async invoke(input, ctx) {
    const target = scopedPath(ctx.workspaceRoot, input.path);
    if (!target) return { ok: false, error: "path outside workspace: " + input.path };
    const info = await stat(target).catch(() => null);
    if (!info?.isFile()) return { ok: false, error: "not a file: " + input.path };
    const content = await readFile(target, "utf8");
    if (!content.includes(input.oldText)) {
      return { ok: false, error: "oldText not found in " + input.path };
    }
    const updated = input.replaceAll
      ? content.split(input.oldText).join(input.newText)
      : content.replace(input.oldText, input.newText);
    await writeFile(target, updated, "utf8");
    return { ok: true, data: { path: input.path, bytes: updated.length } };
  },
};
