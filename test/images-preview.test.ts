import { describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { asLoaded, buildPng } from "./helpers/png";
import { locateImagePaths, pixelPreviewLines } from "../src/tui/images";
import { Tui, type Tty } from "../src/tui/tui";

function visible(s: string): number {
  return s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").length;
}

describe("half-block pixel preview", () => {
  it("renders 256-color half-block rows, bounded, with reset", () => {
    const png = buildPng(8, 8, (x, y) => [200, 10 * x, 10 * y]);
    const lines = pixelPreviewLines({ ...asLoaded(png), mime: "image/png" as const }, 10, 4);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.length).toBeLessThanOrEqual(4);
    for (const line of lines) {
      expect(line).toContain("▀");
      expect(line).toContain("\x1b[38;5;");
      expect(line).toContain(";48;5;");
      expect(visible(line)).toBeLessThanOrEqual(10);
      expect(line.endsWith("\x1b[0m")).toBe(true);
    }
  });

  it("dithers a red/white checkerboard into crisp distinct palette cells", () => {
    const png = buildPng(8, 8, (x, y) => ((x + y) % 2 === 0 ? [255, 0, 0] : [255, 255, 255]));
    const lines = pixelPreviewLines({ ...asLoaded(png), mime: "image/png" as const }, 8, 4);
    const all = lines.join("");
    expect(all).toContain("\x1b[38;5;10;");
    expect(all).toContain("\x1b[38;5;231;");
  });

  it("returns nothing for non-png images — the chip path handles them", () => {
    const jpg = { ...asLoaded(buildPng(2, 2, () => [1, 2, 3])), mime: "image/jpeg" as const };
    expect(pixelPreviewLines(jpg)).toEqual([]);
  });
});

describe("image paths containing spaces", () => {
  it("captures the whole absolute path of a macOS-style screendump", () => {
    const dir = join(tmpdir(), "mimon spaces dir");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "NSIRD_screendump_my shot.png");
    writeFileSync(file, buildPng(2, 2, () => [1, 2, 3]));
    const text = "look at " + file + " please";
    const located = locateImagePaths(text);
    expect(located).toHaveLength(1);
    expect(located[0]!.path).toBe(file);
    expect(text.slice(located[0]!.start, located[0]!.end)).toBe(file);
    rmSync(dir, { recursive: true, force: true });
  });

  it("does not extend prose that merely ends in an image name", () => {
    const dir = join(tmpdir(), "mimon prose dir");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "shot.png");
    writeFileSync(file, buildPng(2, 2, () => [1, 2, 3]));
    const located = locateImagePaths("check this relative shot.png in prose");
    expect(located.map((l) => l.path)).not.toContain(file);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("in-frame image preview", () => {
  class FrameTty implements Tty {
    chunks: string[] = [];
    columns = 100;
    rows = 30;
    write(data: string): void {
      this.chunks.push(data);
    }
  }

  it("attached png renders as pixels inside the box — no protocol escapes, no scroll", async () => {
    const dir = join(tmpdir(), "mimon-frame-img");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "drop.png");
    writeFileSync(file, buildPng(16, 16, (x, y) => [x * 15, y * 15, 200]));
    const tty = new FrameTty();
    const tui = new Tui(tty, {
      onSubmit: () => {}, onCommand: () => {}, onTierChange: () => {}, onAbort: () => {}, onExit: () => {},
      onSetKey: () => {}, onRemoveKey: () => {}, onTestProvider: () => {}, onBindModel: () => {}, onWizardKey: () => {},
    onWizardModel: () => {},
    onTierModelPick: () => {},
      onBrandName: () => {}, onBrandColors: () => {}, onBrandReset: () => {}, onAddProvider: () => {},
    });
    tui.show();
    for (const ch of "see " + file) tui.handleKey({ kind: "char", ch });
    await new Promise((resolve) => setTimeout(resolve, 30));
    const raw = tty.chunks.join("");
    expect(raw).not.toContain("\x1b]1337;");
    expect(raw).not.toContain("\x1b_G");
    const frame = raw.slice(raw.lastIndexOf("\x1b[H"));
    const plainFrame = frame.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
    expect(plainFrame).toContain("▤ drop.png");
    expect(frame).toContain("▀");
    const plain = frame.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\r/g, "\n");
    const lines = plain.split("\n").filter((l) => l.length > 0);
    const top = lines.findIndex((l) => l.includes("╭"));
    const bottom = lines.findIndex((l) => l.includes("╰"));
    const previewIdx = lines.findIndex((l) => l.includes("▤"));
    expect(previewIdx).toBeGreaterThan(top);
    expect(previewIdx).toBeLessThan(bottom);
    expect(tui.hasPendingImages()).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
});
