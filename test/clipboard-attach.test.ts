import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPng } from "./helpers/png";
import { saveClipboardImage } from "../src/tui/clipboard";
import { decodeChunk, Tui, type Tty } from "../src/tui/tui";

function pngBytes(width = 8, height = 8): Uint8Array {
  return new Uint8Array(buildPng(width, height, (x, y) => [x * 30, y * 30, 128]));
}

class MockTty implements Tty {
  chunks: string[] = [];
  columns = 100;
  rows = 30;
  write(data: string): void {
    this.chunks.push(data);
  }
}

function makeTui(clipboardSave?: (destDir: string) => Promise<string | null>): { tui: Tui; tty: MockTty; submitted: string[] } {
  const tty = new MockTty();
  const submitted: string[] = [];
  const tui = new Tui(tty, {
    onSubmit: (t) => submitted.push(t),
    onCommand: () => {},
    onTierChange: () => {},
    onAbort: () => {},
    onExit: () => {},
    onSetKey: () => {},
    onRemoveKey: () => {},
    onTestProvider: () => {},
    onBindModel: () => {},
    onWizardKey: () => {},
    onWizardModel: () => {},
    onTierModelPick: () => {},
    onBrandName: () => {},
    onBrandColors: () => {},
    onBrandReset: () => {},
    onAddProvider: () => {},
  }, clipboardSave ? { clipboardSave } : {});
  return { tui, tty, submitted };
}

function paste(tui: Tui, text: string): void {
  const { keys } = decodeChunk("\x1b[200~" + text + "\x1b[201~");
  for (const key of keys) tui.handleKey(key);
}

async function settle(ms = 40): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

const DEAD_PATH = "/var/folders/67/rv7357616932gtb5t4d07qxw0000gn/T/TemporaryItems/NSIRD_screendump.png";

describe("saveClipboardImage", () => {
  it("writes validated clipboard bytes and returns the saved path", async () => {
    const dir = join(tmpdir(), "mimon-clip-ok");
    rmSync(dir, { recursive: true, force: true });
    const saved = await saveClipboardImage(dir, async () => pngBytes());
    expect(saved).not.toBeNull();
    expect(saved).toContain("pasted-");
    expect(saved!.endsWith(".png")).toBe(true);
    expect(readFileSync(saved!).subarray(1, 4).toString("ascii")).toBe("PNG");
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns null when the clipboard holds no image bytes", async () => {
    const dir = join(tmpdir(), "mimon-clip-empty");
    const saved = await saveClipboardImage(dir, async () => new Uint8Array());
    expect(saved).toBeNull();
    expect(existsSync(dir)).toBe(false);
  });

  it("returns null and writes nothing when the bytes are not an image", async () => {
    const dir = join(tmpdir(), "mimon-clip-junk");
    const junk = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
    const saved = await saveClipboardImage(dir, async () => junk);
    expect(saved).toBeNull();
    expect(existsSync(dir)).toBe(false);
  });
});

describe("pasted dead TemporaryItems paths recover from the clipboard", () => {
  it("converts a dead paste-promise path into a real pending attachment", async () => {
    const dir = join(tmpdir(), "mimon-clip-tui");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "recovered.png");
    const dests: string[] = [];
    const { tui, tty } = makeTui(async (dest) => {
      dests.push(dest);
      writeFileSync(file, buildPng(8, 8, () => [10, 20, 30]));
      return file;
    });
    tui.show();
    paste(tui, DEAD_PATH);
    await settle();
    expect(dests).toHaveLength(1);
    expect(dests[0]).toContain(join(".agent", "uploads"));
    expect(tui.hasPendingImages()).toBe(true);
    expect(tui.takePendingImages()[0]!.path).toBe(file);
    const frame = tty.chunks.join("").slice(tty.chunks.join("").lastIndexOf("\x1b[H"));
    const plainFrame = frame.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
    expect(plainFrame).toContain("▤ recovered.png");
    expect(frame).toContain("▀");
    expect(tui.takePendingImages()).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("keeps the path and explains when the clipboard holds no image", async () => {
    const { tui, tty, submitted } = makeTui(async () => null);
    tui.show();
    paste(tui, DEAD_PATH);
    await settle();
    expect(tui.hasPendingImages()).toBe(false);
    const plain = tty.chunks.join("").replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
    expect(plain).toContain("clipboard holds no image");
    tui.handleKey({ kind: "enter" });
    expect(submitted).toEqual([DEAD_PATH]);
  });

  it("does not consult the clipboard for ordinary missing paths", async () => {
    let calls = 0;
    const { tui } = makeTui(async () => {
      calls += 1;
      return null;
    });
    tui.show();
    paste(tui, "/tmp/definitely-missing-dir/shot.png");
    await settle();
    expect(calls).toBe(0);
    expect(tui.hasPendingImages()).toBe(false);
  });

  it("recovers each dead path only once while typing continues", async () => {
    let calls = 0;
    const { tui } = makeTui(async () => {
      calls += 1;
      return null;
    });
    tui.show();
    for (const ch of DEAD_PATH) tui.handleKey({ kind: "char", ch });
    for (const ch of " and more text") tui.handleKey({ kind: "char", ch });
    await settle(80);
    expect(calls).toBe(1);
  });
});
