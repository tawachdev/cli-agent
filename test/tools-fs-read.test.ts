import { describe, expect, it } from "bun:test";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fsReadTool } from "../src/engine/tools/fs/read";

describe("fs.read tool", () => {
  it("reads a file inside the workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "fsread-"));
    await writeFile(join(root, "notes.txt"), "hello notes");
    const result = await fsReadTool.invoke({ path: "notes.txt" }, { workspaceRoot: root });
    expect(result).toEqual({
      ok: true,
      data: { path: "notes.txt", bytes: 11, content: "hello notes" },
    });
  });

  it("rejects paths outside the workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "fsread-"));
    const escape = await mkdtemp(join(tmpdir(), "fsread-out-"));
    await writeFile(join(escape, "secret.txt"), "nope");
    const relative = await fsReadTool.invoke({ path: "../secret.txt" }, { workspaceRoot: root });
    expect(relative).toEqual({ ok: false, error: "path outside workspace: ../secret.txt" });
    const absolute = await fsReadTool.invoke({ path: join(escape, "secret.txt") }, { workspaceRoot: root });
    expect(absolute.ok).toBe(false);
  });

  it("rejects directories and missing files", async () => {
    const root = await mkdtemp(join(tmpdir(), "fsread-"));
    await mkdir(join(root, "sub"));
    const directory = await fsReadTool.invoke({ path: "sub" }, { workspaceRoot: root });
    expect(directory.ok).toBe(false);
    const missing = await fsReadTool.invoke({ path: "ghost.txt" }, { workspaceRoot: root });
    expect(missing.ok).toBe(false);
  });
});
