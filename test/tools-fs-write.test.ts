import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fsEditTool, fsWriteTool } from "../src/engine/tools/fs/write";

describe("fs.write and fs.edit tools", () => {
  it("creates a file with parent directories and overwrites it", async () => {
    const root = await mkdtemp(join(tmpdir(), "fswrite-"));
    const created = await fsWriteTool.invoke(
      { path: "deep/nested/file.txt", content: "line1\nline2" },
      { workspaceRoot: root },
    );
    expect(created.ok).toBe(true);
    expect(await readFile(join(root, "deep/nested/file.txt"), "utf8")).toBe("line1\nline2");

    const overwritten = await fsWriteTool.invoke(
      { path: "deep/nested/file.txt", content: "replaced" },
      { workspaceRoot: root },
    );
    expect(overwritten.ok).toBe(true);
    expect(await readFile(join(root, "deep/nested/file.txt"), "utf8")).toBe("replaced");
  });

  it("edits an existing file and reports missing oldText", async () => {
    const root = await mkdtemp(join(tmpdir(), "fsedit-"));
    await writeFile(join(root, "code.ts"), "const a = 1;\nconst b = 2;\n");
    const edited = await fsEditTool.invoke(
      { path: "code.ts", oldText: "const b = 2;", newText: "const b = 3;", replaceAll: false },
      { workspaceRoot: root },
    );
    expect(edited.ok).toBe(true);
    expect(await readFile(join(root, "code.ts"), "utf8")).toBe("const a = 1;\nconst b = 3;\n");

    const missing = await fsEditTool.invoke(
      { path: "code.ts", oldText: "not present", newText: "x", replaceAll: false },
      { workspaceRoot: root },
    );
    expect(missing.ok).toBe(false);
  });

  it("rejects paths outside the workspace and shows a diff preview", async () => {
    const root = await mkdtemp(join(tmpdir(), "fswrite-"));
    const outside = await fsWriteTool.invoke(
      { path: "../evil.txt", content: "no" },
      { workspaceRoot: root },
    );
    expect(outside.ok).toBe(false);
    await mkdir(join(root, "sub"), { recursive: true });
    const preview = fsWriteTool.preview?.({ path: "new.txt", content: "a\nb\n" });
    expect(preview).toContain("+ a");
    const editPreview = fsEditTool.preview?.({
      path: "new.txt",
      oldText: "a\nb",
      newText: "a\nc",
      replaceAll: false,
    });
    expect(editPreview).toContain("+ c");
    expect(editPreview).toContain("- b");
  });
});
