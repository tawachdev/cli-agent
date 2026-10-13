import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPng } from "./helpers/png";
import { decodeChunk, Tui, type Tty } from "../src/tui/tui";
import type { LoadedImage } from "../src/tui/images";

class MockTty implements Tty {
  chunks: string[] = [];
  columns = 100;
  rows = 30;
  write(data: string): void {
    this.chunks.push(data);
  }
}

function makeTui(tty: MockTty, opened: string[] = []): Tui {
  return new Tui(tty, {
    onSubmit: () => {},
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
  }, {
    imageSupport: "iterm",
    openImage: (image) => opened.push(image.path),
  });
}

function loaded(name: string, rgb: [number, number, number] = [60, 120, 180]): LoadedImage {
  const png = buildPng(8, 8, () => rgb);
  return {
    path: "/tmp/" + name,
    name,
    mime: "image/png",
    base64: png.toString("base64"),
    bytes: png.length,
    width: 8,
    height: 8,
  };
}

const strip = (s: string): string => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");

const frameText = (frame: string): string[] => frame.split("\r\n").map(strip);

type Placement = { row: number; col: number; width: number; height: number; base64: string };

const placements = (frame: string): Placement[] =>
  [...frame.matchAll(/\x1b\[(\d+);(\d+)H\x1b\]1337;File=inline=1;preserveAspectRatio=1;size=\d+;width=(\d+);height=(\d+);name=[^:]*:([^\x07]*)\x07/g)].map((m) => ({
    row: Number(m[1]),
    col: Number(m[2]),
    width: Number(m[3]),
    height: Number(m[4]),
    base64: m[5]!,
  }));

function fullFrame(tui: Tui, tty: MockTty): string {
  tty.chunks.length = 0;
  tui.hide();
  tui.show();
  return tty.chunks.join("");
}

async function stage(tui: Tui, count: number): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "agent-strip-"));
  const paths: string[] = [];
  for (let i = 0; i < count; i++) {
    const file = join(dir, "shot-" + i + ".png");
    writeFileSync(file, buildPng(16, 9, () => [40 * i, 90, 160]));
    paths.push(file);
  }
  for (const key of decodeChunk("\x1b[200~" + paths.join(" ") + "\x1b[201~").keys) tui.handleKey(key);
  await new Promise((resolve) => setTimeout(resolve, 80));
}

function sideBySide(spots: Placement[]): boolean {
  const sorted = [...spots].sort((a, b) => a.col - b.col);
  return sorted.every((spot, i) => i === 0 || (spot.row === sorted[0]!.row && sorted[i - 1]!.col + sorted[i - 1]!.width <= spot.col));
}

describe("sent images render as thumbnails under their message", () => {
  it("draws the thumbnail directly below its message, aligned with the text column", () => {
    const tty = new MockTty();
    const tui = makeTui(tty);
    tui.historyPush("alpha says hi");
    tui.openImage(loaded("first.png"));
    tui.historyPush("beta comes later");
    const frame = fullFrame(tui, tty);
    const text = frameText(frame);
    const msg = text.findIndex((r) => r.includes("alpha says hi"));
    const later = text.findIndex((r) => r.includes("beta comes later"));
    const spots = placements(frame);
    expect(spots).toHaveLength(1);
    expect(spots[0]!.row).toBe(msg + 2);
    expect(spots[0]!.row - 1 + spots[0]!.height).toBe(later);
    expect(spots[0]!.col).toBe(text[msg]!.indexOf("alpha says hi") + 1);
  });

  it("lays images sent together side by side, small, on one row", () => {
    const tty = new MockTty();
    const tui = makeTui(tty);
    tui.historyPush("YOU compare these");
    for (const name of ["a.png", "b.png", "c.png", "d.png"]) tui.openImage(loaded(name));
    const frame = fullFrame(tui, tty);
    const text = frameText(frame);
    const prompt = text.findIndex((r) => r.includes("YOU compare these"));
    const spots = placements(frame);
    expect(spots).toHaveLength(4);
    expect(sideBySide(spots)).toBe(true);
    expect(spots.every((spot) => spot.row === prompt + 2)).toBe(true);
    expect(spots.every((spot) => spot.width <= 14 && spot.height <= 4)).toBe(true);
  });

  it("keeps each group anchored to its own message as more arrive", () => {
    const tty = new MockTty();
    const tui = makeTui(tty);
    tui.historyPush("msg zero");
    tui.openImage(loaded("one.png"));
    tui.historyPush("msg one");
    tui.historyPush("msg two");
    tui.openImage(loaded("two.png"));
    tui.historyPush("msg three");
    const frame = fullFrame(tui, tty);
    const text = frameText(frame);
    const at = (needle: string): number => text.findIndex((r) => r.includes(needle));
    const spots = placements(frame);
    expect(spots).toHaveLength(2);
    expect(spots[0]!.row).toBe(at("msg zero") + 2);
    expect(spots[1]!.row).toBe(at("msg two") + 2);
    expect(spots[0]!.col).toBe(spots[1]!.col);
  });

  it("drops the oldest messages together with their thumbnails when over budget", () => {
    const tty = new MockTty();
    tty.rows = 16;
    const tui = makeTui(tty);
    tui.historyPush("msg-00");
    tui.openImage(loaded("old.png"));
    for (let i = 1; i < 40; i++) tui.historyPush("msg-" + String(i).padStart(2, "0"));
    const frame = fullFrame(tui, tty);
    const all = frameText(frame).join("\n");
    expect(all).toContain("msg-39");
    expect(all).not.toContain("msg-00");
    expect(frame).not.toContain("\x00");
    expect(placements(frame)).toHaveLength(0);
  });

  it("never shows the tail of a thumbnail whose top row scrolled away", () => {
    const tty = new MockTty();
    tty.rows = 16;
    const tui = makeTui(tty);
    tui.historyPush("anchor");
    tui.openImage(loaded("cut.png"));
    for (let n = 0; n < 12; n++) {
      tui.historyPush("line " + n);
      const frame = fullFrame(tui, tty);
      const spots = placements(frame);
      const marked = frame.split("\r\n").filter((row) => row.includes("\x00")).length;
      expect(marked === 0 || (spots.length === 1 && marked === spots[0]!.height)).toBe(true);
    }
  });

  it("repaints a thumbnail whenever any of its rows moved during incremental scrolling", () => {
    const tty = new MockTty();
    tty.rows = 16;
    const tui = makeTui(tty);
    const imageA = loaded("a.png", [200, 20, 20]);
    const imageB = loaded("b.png", [20, 20, 200]);
    for (let i = 0; i < 24; i++) tui.historyPush("filler " + String(i).padStart(2, "0"));
    tui.historyPush("anchor a");
    tui.openImage(imageA);
    tui.historyPush("anchor b");
    tui.openImage(imageB);
    tui.show();
    tty.chunks.length = 0;
    tui.historyPush("shift everything by one");
    const painted = placements(tty.chunks.join("")).map((spot) => [spot.row, spot.base64]);
    const settled = placements(fullFrame(tui, tty)).map((spot) => [spot.row, spot.base64]);
    expect(settled.length).toBeGreaterThan(0);
    expect(painted).toEqual(settled);
    expect(settled.map(([, base64]) => base64)).toContain(imageB.base64);
  });

  it("keeps the anchor and alignment after a terminal resize", () => {
    const tty = new MockTty();
    const tui = makeTui(tty);
    tui.historyPush("alpha says hi");
    tui.openImage(loaded("first.png"));
    tui.historyPush("beta comes later");
    tui.show();
    tty.columns = 60;
    tty.rows = 24;
    const frame = fullFrame(tui, tty);
    const text = frameText(frame);
    const msg = text.findIndex((r) => r.includes("alpha says hi"));
    const spots = placements(frame);
    expect(spots).toHaveLength(1);
    expect(spots[0]!.row).toBe(msg + 2);
    expect(spots[0]!.col).toBe(text[msg]!.indexOf("alpha says hi") + 1);
  });
});

describe("staged images sit in the composer as a thumbnail strip", () => {
  const composer = (frame: string): { top: number; input: number } => {
    const text = frameText(frame);
    return { top: text.findIndex((r) => r.includes("├")) + 1, input: text.findIndex((r) => r.includes("ctx ")) };
  };

  it("places every staged image side by side between the divider and the input", async () => {
    const tty = new MockTty();
    const tui = makeTui(tty);
    tui.enableHero("0.0.0");
    tui.show();
    await stage(tui, 4);
    expect(tui.hasPendingImages()).toBe(true);
    const frame = fullFrame(tui, tty);
    const { top, input } = composer(frame);
    const spots = placements(frame).filter((spot) => spot.row > top && spot.row < input);
    expect(spots).toHaveLength(4);
    expect(sideBySide(spots)).toBe(true);
    expect(frameText(frame).join("\n")).toContain("your keys");
    expect(frameText(frame).join("\n")).toContain("click an image to open it");
  });

  it("fits inside the box at every width without overlapping", async () => {
    const tty = new MockTty();
    const tui = makeTui(tty);
    tui.show();
    await stage(tui, 4);
    for (const columns of [140, 100, 60, 40, 30]) {
      tty.columns = columns;
      const frame = fullFrame(tui, tty);
      const spots = placements(frame);
      expect(spots).toHaveLength(4);
      const rows = frameText(frame);
      for (const spot of spots) {
        const right = rows[spot.row - 1]!.lastIndexOf("│") + 1;
        expect(spot.col + spot.width).toBeLessThan(right);
      }
      const byRow = new Map<number, Placement[]>();
      for (const spot of spots) byRow.set(spot.row, [...(byRow.get(spot.row) ?? []), spot]);
      for (const group of byRow.values()) expect(sideBySide(group)).toBe(true);
    }
  });
});

describe("clicking a thumbnail opens it full size", () => {
  it("turns mouse reporting on with thumbnails on screen and off once they are gone", () => {
    const tty = new MockTty();
    const tui = makeTui(tty);
    tui.show();
    expect(tty.chunks.join("")).not.toContain("\x1b[?1000h");
    tui.historyPush("YOU look");
    tui.openImage(loaded("seen.png"));
    expect(tty.chunks.join("")).toContain("\x1b[?1000h\x1b[?1006h");
    tty.chunks.length = 0;
    tui.hide();
    expect(tty.chunks.join("")).toContain("\x1b[?1000l\x1b[?1006l");
  });

  it("opens the clicked image and ignores clicks elsewhere", () => {
    const tty = new MockTty();
    const opened: string[] = [];
    const tui = makeTui(tty, opened);
    tui.historyPush("YOU two shots");
    tui.openImage(loaded("left.png"));
    tui.openImage(loaded("right.png"));
    const spots = placements(fullFrame(tui, tty)).sort((a, b) => a.col - b.col);
    const click = (row: number, col: number): void => {
      for (const key of decodeChunk("\x1b[<0;" + col + ";" + row + "M").keys) tui.handleKey(key);
    };
    click(1, 1);
    expect(opened).toEqual([]);
    click(spots[1]!.row + 1, spots[1]!.col + 2);
    expect(opened).toEqual(["/tmp/right.png"]);
    click(spots[0]!.row, spots[0]!.col);
    expect(opened).toEqual(["/tmp/right.png", "/tmp/left.png"]);
  });

  it("decodes only a plain left press as a click", () => {
    expect(decodeChunk("\x1b[<0;12;5M").keys).toEqual([{ kind: "click", col: 12, row: 5 }]);
    expect(decodeChunk("\x1b[<0;12;5m").keys).toEqual([]);
    expect(decodeChunk("\x1b[<64;12;5M").keys).toEqual([]);
    expect(decodeChunk("\x1b[<2;12;5M").keys).toEqual([]);
  });
});
