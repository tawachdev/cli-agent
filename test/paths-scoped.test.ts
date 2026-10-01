import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scopedPath } from "../src/engine/shared/paths";

describe("scopedPath containment", () => {
  const ws = mkdtempSync(join(tmpdir(), "mimon-scoped-"));
  const outside = mkdtempSync(join(tmpdir(), "mimon-outside-"));
  const secret = join(outside, "secret.txt");
  writeFileSync(secret, "TOP SECRET");
  mkdirSync(join(ws, "src"), { recursive: true });
  writeFileSync(join(ws, "src", "ok.txt"), "fine");
  symlinkSync(secret, join(ws, "steal"));
  symlinkSync(join(outside, "new.txt"), join(ws, "broken"));
  symlinkSync(join(ws, "src"), join(ws, "inside"));

  it("allows plain paths inside the workspace", () => {
    expect(scopedPath(ws, "src/ok.txt")).toBe(realpathSync(join(ws, "src", "ok.txt")));
    expect(scopedPath(ws, "src")).toBe(realpathSync(join(ws, "src")));
    expect(scopedPath(ws, ".")).toBe(realpathSync(ws));
  });

  it("rejects lexical escapes", () => {
    expect(scopedPath(ws, "../outside")).toBeNull();
    expect(scopedPath(ws, "src/../../etc/passwd")).toBeNull();
  });

  it("rejects symlinks that resolve outside the workspace", () => {
    expect(scopedPath(ws, "steal")).toBeNull();
    expect(scopedPath(ws, "broken")).toBeNull();
    expect(scopedPath(ws, "steal")).toBeNull();
  });

  it("allows symlinks that resolve inside the workspace", () => {
    expect(scopedPath(ws, "inside/ok.txt")).toBe(realpathSync(join(ws, "src", "ok.txt")));
  });
});
