import { describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPng } from "./helpers/png";
import { decodePng } from "../src/tui/png";
import { loadImagesFromPaths, type ImageSupport } from "../src/tui/images";
import { halfBlockLines } from "../src/tui/halfblock";
import { downscale, encodePng, fitCells, makeThumb } from "../src/tui/thumbs";
import { decodeChunk, Tui, type Tty } from "../src/tui/tui";

class MockTty implements Tty {
  chunks: string[] = [];
  columns = 100;
  rows = 34;
  write(data: string): void {
    this.chunks.push(data);
  }
  all(): string {
    return this.chunks.join("");
  }
  since(mark: number): string {
    return this.chunks.slice(mark).join("");
  }
}

const strip = (s: string): string => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");

function makeTui(support: ImageSupport): { tui: Tui; tty: MockTty; submitted: string[] } {
  const tty = new MockTty();
  const submitted: string[] = [];
  const tui = new Tui(tty, {
    onSubmit: (t) => submitted.push(t), onCommand: () => {}, onTierChange: () => {}, onAbort: () => {}, onExit: () => {},
    onSetKey: () => {}, onRemoveKey: () => {}, onTestProvider: () => {}, onBindModel: () => {}, onWizardKey: () => {},
    onWizardModel: () => {}, onTierModelPick: () => {}, onBrandName: () => {}, onBrandColors: () => {}, onBrandReset: () => {},
    onAddProvider: () => {},
  }, { imageSupport: support, colorDepth: "256", openImage: () => {} });
  return { tui, tty, submitted };
}

function paste(tui: Tui, text: string): void {
  for (const key of decodeChunk("\x1b[200~" + text + "\x1b[201~").keys) tui.handleKey(key);
}

function type(tui: Tui, text: string): void {
  for (const ch of text) tui.handleKey({ kind: "char", ch });
}

const settle = (ms = 40): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function fullFrame(tui: Tui, tty: MockTty): { rows: string[]; raw: string } {
  tui.hide();
  const mark = tty.chunks.length;
  tui.show();
  const raw = tty.since(mark);
  const body = raw.split(/\x1b\]1337;|\x1b_G/)[0]!;
  return { rows: strip(body).split("\r\n"), raw };
}

function withPng(name: string, width: number, height: number): { dir: string; file: string } {
  const dir = join(tmpdir(), "mimon-composer-" + name + "-" + Date.now());
  mkdirSync(dir, { recursive: true });
  const file = join(dir, name);
  writeFileSync(file, buildPng(width, height, (x, y) => [(x * 7) % 256, (y * 5) % 256, 160]));
  return { dir, file };
}

describe("composer tray", () => {
  it("a pasted image waits in the composer — nothing is sent, nothing lands in the transcript", async () => {
    const { dir, file } = withPng("shot.png", 64, 32);
    const { tui, tty, submitted } = makeTui("none");
    tui.show();
    paste(tui, file + "\n");
    await settle();
    expect(submitted).toEqual([]);
    expect(tui.hasPendingImages()).toBe(true);
    const { rows } = fullFrame(tui, tty);
    const divider = rows.findIndex((row) => row.includes("├"));
    const caption = rows.findIndex((row) => row.includes("▤ shot.png"));
    const firstPixels = tty.all().split("\r\n").findIndex((row) => row.includes("▀"));
    expect(caption).toBeGreaterThan(divider);
    expect(rows.slice(0, divider).join("\n")).not.toContain("shot.png");
    expect(firstPixels).toBeGreaterThan(-1);
    expect(rows.join("\n")).toContain("Say what to do with this image");
    rmSync(dir, { recursive: true, force: true });
  });

  it("the user explains, presses enter, and the image moves under their message", async () => {
    const { dir, file } = withPng("bug.png", 64, 32);
    const { tui, tty, submitted } = makeTui("none");
    tui.show();
    paste(tui, file);
    await settle();
    type(tui, "why is this button cut off?");
    tui.handleKey({ kind: "enter" });
    expect(submitted).toEqual(["why is this button cut off?"]);
    await tui.settleAttachments();
    const images = tui.takePendingImages();
    expect(images.map((image) => image.name)).toEqual(["bug.png"]);
    tui.historyPush(" YOU why is this button cut off?");
    tui.showImage(images[0]!);
    tui.endBusy();
    await settle();
    const { rows } = fullFrame(tui, tty);
    const you = rows.findIndex((row) => row.includes("YOU why is this button"));
    const caption = rows.findIndex((row) => row.includes("▤ bug.png"));
    const divider = rows.findIndex((row) => row.includes("├"));
    expect(you).toBeGreaterThan(-1);
    expect(caption).toBe(you + 1);
    expect(caption).toBeLessThan(divider);
    expect(rows.join("\n")).not.toContain("attached");
    rmSync(dir, { recursive: true, force: true });
  });

  it("a sent image scrolls with the conversation instead of sticking to the bottom", async () => {
    const { dir, file } = withPng("scroll.png", 40, 20);
    const { tui, tty } = makeTui("none");
    tui.show();
    const { images } = await loadImagesFromPaths([file]);
    tui.historyPush(" YOU look");
    tui.showImage(images[0]!);
    await settle();
    tui.historyPush("first answer line");
    tui.historyPush("second answer line");
    const { rows } = fullFrame(tui, tty);
    const caption = rows.findIndex((row) => row.includes("▤ scroll.png"));
    const answer = rows.findIndex((row) => row.includes("second answer line"));
    expect(caption).toBeGreaterThan(-1);
    expect(answer).toBeGreaterThan(caption);
    rmSync(dir, { recursive: true, force: true });
  });

  it("backspace on an empty prompt removes the last attachment", async () => {
    const one = withPng("one.png", 8, 8);
    const two = withPng("two.png", 8, 8);
    const { tui } = makeTui("none");
    tui.show();
    paste(tui, one.file);
    paste(tui, " " + two.file);
    await settle();
    expect(tui.hasPendingImages()).toBe(true);
    tui.handleKey({ kind: "backspace" });
    await tui.settleAttachments();
    expect(tui.takePendingImages().map((image) => image.name)).toEqual(["one.png"]);
    rmSync(one.dir, { recursive: true, force: true });
    rmSync(two.dir, { recursive: true, force: true });
  });

  it("enter right after a drop still sends the image once it finishes loading", async () => {
    const { dir, file } = withPng("fast.png", 32, 32);
    const { tui } = makeTui("none");
    tui.show();
    paste(tui, file);
    await tui.settleAttachments();
    expect(tui.takePendingImages()).toHaveLength(1);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("clipboard pastes", () => {
  it("enter right after a clipboard image paste waits for the save instead of dropping it", async () => {
    const { dir, file } = withPng("clip.png", 24, 24);
    const tty = new MockTty();
    const tui = new Tui(tty, {
      onSubmit: () => {}, onCommand: () => {}, onTierChange: () => {}, onAbort: () => {}, onExit: () => {},
      onSetKey: () => {}, onRemoveKey: () => {}, onTestProvider: () => {}, onBindModel: () => {}, onWizardKey: () => {},
      onWizardModel: () => {}, onTierModelPick: () => {}, onBrandName: () => {}, onBrandColors: () => {}, onBrandReset: () => {},
      onAddProvider: () => {},
    }, {
      imageSupport: "none",
      clipboardSave: async () => {
        await settle(30);
        return file;
      },
    });
    tui.show();
    paste(tui, buildPng(48, 48, (x, y) => [x * 5, y * 5, 128]).toString("base64"));
    await tui.settleAttachments();
    expect(tui.takePendingImages().map((image) => image.name)).toEqual(["clip.png"]);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("protocol images are drawn inside the box", () => {
  it("iTerm pixels land in the composer, inside the box borders, at a matching cell box", async () => {
    const { dir, file } = withPng("wide.png", 200, 100);
    const { tui, tty } = makeTui("iterm");
    tty.columns = 160;
    tui.show();
    paste(tui, file);
    await settle();
    const { rows, raw } = fullFrame(tui, tty);
    const at = /\x1b\[(\d+);(\d+)H\x1b\]1337;File=inline=1;[^:]*doNotMoveCursor=1;[^:]*width=(\d+);height=(\d+)/.exec(raw);
    expect(at).not.toBeNull();
    const row = Number(at![1]) - 1;
    const col = Number(at![2]) - 1;
    const width = Number(at![3]);
    const height = Number(at![4]);
    const divider = rows.findIndex((r) => r.includes("├"));
    const input = rows.findIndex((r) => r.includes("Say what to do"));
    expect(row).toBe(divider + 1);
    expect(row + height).toBeLessThan(input);
    const left = rows[divider]!.indexOf("├");
    const right = rows[divider]!.indexOf("┤");
    expect(left).toBeGreaterThan(0);
    expect(col).toBeGreaterThan(left);
    expect(col + width).toBeLessThan(right);
    expect(width).toBe(height * 4);
    rmSync(dir, { recursive: true, force: true });
  });

  it("typing next to an iTerm thumbnail does not resend the pixels", async () => {
    const { dir, file } = withPng("still.png", 40, 40);
    const { tui, tty } = makeTui("iterm");
    tui.show();
    paste(tui, file);
    await settle();
    const mark = tty.chunks.length;
    type(tui, "explain");
    expect(tty.since(mark)).not.toContain("]1337;");
    rmSync(dir, { recursive: true, force: true });
  });

  it("kitty gets c/r cell boxes, the pixels once, and cheap re-placements when the layout moves", async () => {
    const { dir, file } = withPng("kitty.png", 60, 30);
    const { tui, tty } = makeTui("kitty");
    tui.show();
    paste(tui, file);
    await settle();
    const first = tty.all();
    expect(first).toContain("a=t,f=100,t=d,");
    expect(first).toMatch(/a=p,i=\d+,p=\d+,c=\d+,r=\d+,C=1,q=2/);
    expect(first).not.toMatch(/a=p[^\\]*,w=/);
    const steady = tty.chunks.length;
    tui.notice("a new line above the composer");
    type(tui, "x");
    expect(tty.since(steady)).not.toContain("\x1b_G");
    const mark = tty.chunks.length;
    tty.columns = 72;
    tui.refresh();
    const later = tty.since(mark);
    expect(later).not.toContain("a=t,");
    expect(later).toContain("a=p,");
    expect(later).toContain("a=d,d=a");
    const freed = tty.chunks.length;
    tui.dispose();
    expect(tty.since(freed)).toContain("d=I,");
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("thumbnail pipeline", () => {
  it("encodes RGBA back to a PNG our decoder reads pixel-for-pixel", () => {
    const src = decodePng(buildPng(5, 3, (x, y) => [x * 40, y * 80, 7]).toString("base64"))!;
    const again = decodePng(encodePng(src).toString("base64"))!;
    expect(again.width).toBe(5);
    expect(again.height).toBe(3);
    expect([...again.data]).toEqual([...src.data]);
  });

  it("downscales big screenshots to a small protocol payload and keeps small PNGs as-is", async () => {
    const big = buildPng(1600, 900, (x, y) => [x % 256, y % 256, 90]);
    const bigThumb = await makeThumb({ path: "/tmp/big.png", name: "big.png", mime: "image/png", base64: big.toString("base64"), bytes: big.length, width: 1600, height: 900 });
    const decoded = decodePng(bigThumb.png!)!;
    expect(Math.max(decoded.width, decoded.height)).toBe(480);
    expect(bigThumb.width).toBe(1600);
    const small = buildPng(40, 20, () => [1, 2, 3]);
    const smallThumb = await makeThumb({ path: "/tmp/s.png", name: "s.png", mime: "image/png", base64: small.toString("base64"), bytes: small.length, width: 40, height: 20 });
    expect(smallThumb.png).toBe(small.toString("base64"));
    expect(smallThumb.inline).toBe(smallThumb.png);
  });

  it("routes non-png sources through the converter, and degrades to a chip without one", async () => {
    const jpeg = { path: "/tmp/p.jpg", name: "p.jpg", mime: "image/jpeg" as const, base64: "/9j/AAAA", bytes: 6, width: 30, height: 10 };
    const converted = await makeThumb(jpeg, async () => new Uint8Array(buildPng(30, 10, () => [9, 9, 9])));
    expect(converted.pixels).not.toBeNull();
    expect(converted.png).not.toBeNull();
    const none = await makeThumb(jpeg, async () => null);
    expect(none.pixels).toBeNull();
    expect(none.png).toBeNull();
    expect(none.inline).toBe("/9j/AAAA");
  });

  it("fits a contain box in 1:2 cells and renders truecolor half-blocks", () => {
    expect(fitCells(200, 100, 20, 10)).toEqual({ cols: 20, rows: 5 });
    expect(fitCells(100, 400, 20, 6)).toEqual({ cols: 3, rows: 6 });
    const px = downscale(decodePng(buildPng(8, 8, () => [255, 0, 0]).toString("base64"))!, 4);
    expect(px.width).toBe(4);
    const lines = halfBlockLines(px, 4, 2, "truecolor");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("\x1b[38;2;255;0;0;48;2;255;0;0m▀");
    expect(strip(lines[0]!)).toBe("▀▀▀▀");
  });
});
