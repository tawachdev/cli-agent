import { deflateSync } from "node:zlib";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodePng, type RgbaPixels } from "./png";
import type { LoadedImage } from "./images";

// Long side of the PNG we hand to iTerm/kitty. Big enough to look crisp in a
// thumbnail box, small enough that a full repaint never ships megabytes.
const PROTOCOL_EDGE = 480;
// iTerm can draw any format natively; past this size we would rather show a chip
// than push the original bytes through the pty on every repaint.
const ORIGINAL_INLINE_CAP = 2 * 1024 * 1024;
const KITTY_CHUNK = 4096;
// Transparent pixels are painted over the brand background for half-blocks.
const MATTE: [number, number, number] = [10, 10, 16];

export type ColorDepth = "truecolor" | "256";

export interface Thumb {
  // kitty image id — the pixels are transmitted once, then only placed
  id: number;
  width: number;
  height: number;
  // downscaled RGBA for half-block rendering, null when we could not decode
  pixels: RgbaPixels | null;
  // base64 PNG for kitty (PNG only) and iTerm
  png: string | null;
  // base64 bytes iTerm can draw: the PNG thumb, else the small original
  inline: string | null;
}

export type ToPng = (path: string) => Promise<Uint8Array | null>;

let nextKittyId = 0x6d00 + Math.floor(Math.random() * 0x8000) * 0x100;

function crc32(buf: Uint8Array): number {
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

export function encodePng(pixels: RgbaPixels): Buffer {
  const { width, height, data } = pixels;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 4 + 1);
    raw[row] = 0;
    raw.set(data.subarray(y * width * 4, (y + 1) * width * 4), row + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

// Box-filter downscale so every source pixel contributes — no aliasing on text
// in screenshots, which point sampling would shred.
export function downscale(src: RgbaPixels, maxEdge: number): RgbaPixels {
  const scale = Math.min(1, maxEdge / Math.max(src.width, src.height));
  if (scale >= 1) return src;
  const width = Math.max(1, Math.round(src.width * scale));
  const height = Math.max(1, Math.round(src.height * scale));
  const sums = new Float64Array(width * height * 4);
  const counts = new Float64Array(width * height);
  for (let y = 0; y < src.height; y++) {
    const ty = Math.min(height - 1, Math.floor((y * height) / src.height));
    for (let x = 0; x < src.width; x++) {
      const tx = Math.min(width - 1, Math.floor((x * width) / src.width));
      const s = (y * src.width + x) * 4;
      const t = ty * width + tx;
      const alpha = src.data[s + 3]! / 255;
      sums[t * 4] = sums[t * 4]! + src.data[s]! * alpha;
      sums[t * 4 + 1] = sums[t * 4 + 1]! + src.data[s + 1]! * alpha;
      sums[t * 4 + 2] = sums[t * 4 + 2]! + src.data[s + 2]! * alpha;
      sums[t * 4 + 3] = sums[t * 4 + 3]! + alpha;
      counts[t] = counts[t]! + 1;
    }
  }
  const data = new Uint8Array(width * height * 4);
  for (let t = 0; t < width * height; t++) {
    const a = sums[t * 4 + 3]!;
    if (a > 0) {
      data[t * 4] = Math.round(sums[t * 4]! / a);
      data[t * 4 + 1] = Math.round(sums[t * 4 + 1]! / a);
      data[t * 4 + 2] = Math.round(sums[t * 4 + 2]! / a);
    }
    data[t * 4 + 3] = Math.round((a / counts[t]!) * 255);
  }
  return { width, height, data };
}

async function sipsToPng(path: string): Promise<Uint8Array | null> {
  const dir = mkdtempSync(join(tmpdir(), "mimon-thumb-"));
  const out = join(dir, "thumb.png");
  try {
    const proc = Bun.spawn(["sips", "-s", "format", "png", "-Z", String(PROTOCOL_EDGE), path, "--out", out], {
      stdout: "ignore",
      stderr: "ignore",
    });
    await proc.exited;
    return proc.exitCode === 0 ? new Uint8Array(readFileSync(out)) : null;
  } catch {
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Non-PNG sources (jpeg, gif, webp, bmp) need a converter for kitty and the
// half-block preview. macOS always ships sips; elsewhere we fall back to a chip.
export const defaultToPng: ToPng = (path) =>
  process.platform === "darwin" ? sipsToPng(path) : Promise.resolve(null);

function decodedBytes(base64: string): number {
  const pad = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.floor((base64.length * 3) / 4) - pad;
}

export async function makeThumb(image: LoadedImage, toPng: ToPng = defaultToPng): Promise<Thumb> {
  let decoded: RgbaPixels | null = null;
  if (image.mime === "image/png") {
    decoded = decodePng(image.base64);
  } else {
    const converted = await toPng(image.path).catch(() => null);
    if (converted && converted.length > 0) decoded = decodePng(Buffer.from(converted).toString("base64"));
  }
  const small = decoded ? downscale(decoded, PROTOCOL_EDGE) : null;
  // A PNG we cannot decode (16-bit, interlaced) still renders natively in the terminal.
  const nativePng = image.mime === "image/png" && image.bytes <= ORIGINAL_INLINE_CAP ? image.base64 : null;
  const png = small ? (small === decoded && nativePng ? nativePng : encodePng(small).toString("base64")) : nativePng;
  const original = image.bytes <= ORIGINAL_INLINE_CAP ? image.base64 : null;
  nextKittyId += 1;
  return {
    id: nextKittyId,
    width: image.width ?? decoded?.width ?? 0,
    height: image.height ?? decoded?.height ?? 0,
    pixels: small,
    png,
    inline: png ?? original,
  };
}

// Contain box in terminal cells. A cell is about twice as tall as it is wide,
// so one row covers two "square" pixels of height.
export function fitCells(width: number, height: number, maxCols: number, maxRows: number): { cols: number; rows: number } {
  const capCols = Math.max(1, Math.floor(maxCols));
  const capRows = Math.max(1, Math.floor(maxRows));
  if (!(width > 0) || !(height > 0)) return { cols: capCols, rows: Math.min(capRows, Math.max(1, Math.round(capCols / 2))) };
  let cols = capCols;
  let rows = Math.round((cols * height) / width / 2);
  if (rows > capRows) {
    rows = capRows;
    cols = Math.round((rows * 2 * width) / height);
  }
  return { cols: Math.max(1, Math.min(capCols, cols)), rows: Math.max(1, Math.min(capRows, rows)) };
}

export function colorDepth(env: Record<string, string | undefined> = process.env): ColorDepth {
  const colorterm = (env["COLORTERM"] ?? "").toLowerCase();
  if (colorterm === "truecolor" || colorterm === "24bit") return "truecolor";
  const program = env["TERM_PROGRAM"] ?? "";
  if (program === "iTerm.app" || program === "WezTerm" || program === "vscode" || program === "ghostty") return "truecolor";
  return "256";
}

const XTERM16_RGB: Array<[number, number, number]> = [
  [0, 0, 0], [205, 0, 0], [0, 205, 0], [205, 205, 0],
  [0, 0, 238], [85, 85, 255], [205, 0, 205], [0, 205, 205],
  [229, 229, 229], [127, 127, 127], [255, 0, 0], [0, 255, 0],
  [255, 255, 0], [92, 92, 255], [255, 0, 255], [0, 255, 255],
];
const CUBE_STEPS = [0, 95, 135, 175, 215, 255];
const PALETTE256: Array<[number, number, number]> = Array.from({ length: 256 }, (_v, i): [number, number, number] => {
  if (i < 16) return XTERM16_RGB[i]!;
  if (i < 232) {
    const n = i - 16;
    return [CUBE_STEPS[Math.floor(n / 36)]!, CUBE_STEPS[Math.floor(n / 6) % 6]!, CUBE_STEPS[n % 6]!];
  }
  const v = 8 + (i - 232) * 10;
  return [v, v, v];
});

function nearestPaletteIndex(r: number, g: number, b: number): number {
  let best = 16;
  let bestDist = Infinity;
  for (let i = 0; i < 256; i++) {
    const p = PALETTE256[i]!;
    const dr = r - p[0]!;
    const dg = g - p[1]!;
    const db = b - p[2]!;
    const dist = dr * dr + dg * dg + db * db;
    if (dist < bestDist) {
      bestDist = dist;
      best = i;
    }
  }
  return best;
}

function sampleGrid(pixels: RgbaPixels, cols: number, gridRows: number): Array<[number, number, number]> {
  const grid: Array<[number, number, number]> = [];
  for (let gy = 0; gy < gridRows; gy++) {
    for (let cx = 0; cx < cols; cx++) {
      const sx0 = Math.max(0, Math.floor((cx * pixels.width) / cols));
      const sy0 = Math.max(0, Math.floor((gy * pixels.height) / gridRows));
      const sx1 = Math.min(pixels.width, Math.max(sx0 + 1, Math.ceil(((cx + 1) * pixels.width) / cols)));
      const sy1 = Math.min(pixels.height, Math.max(sy0 + 1, Math.ceil(((gy + 1) * pixels.height) / gridRows)));
      const stride = Math.max(1, Math.floor(Math.max(sx1 - sx0, sy1 - sy0) / 24));
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      for (let y = sy0; y < sy1; y += stride) {
        for (let x = sx0; x < sx1; x += stride) {
          const o = (y * pixels.width + x) * 4;
          const a = pixels.data[o + 3]! / 255;
          r += pixels.data[o]! * a + MATTE[0] * (1 - a);
          g += pixels.data[o + 1]! * a + MATTE[1] * (1 - a);
          b += pixels.data[o + 2]! * a + MATTE[2] * (1 - a);
          n += 1;
        }
      }
      grid.push(n === 0 ? [...MATTE] : [r / n, g / n, b / n]);
    }
  }
  return grid;
}

function dither256(grid: Array<[number, number, number]>, cols: number, gridRows: number): number[] {
  const idx: number[] = [];
  const at = (x: number, y: number): [number, number, number] | null =>
    x < 0 || x >= cols || y >= gridRows ? null : grid[y * cols + x]!;
  for (let gy = 0; gy < gridRows; gy++) {
    for (let cx = 0; cx < cols; cx++) {
      const me = at(cx, gy)!;
      const clamp = (v: number): number => Math.max(0, Math.min(255, Math.round(v)));
      const pick = nearestPaletteIndex(clamp(me[0]), clamp(me[1]), clamp(me[2]));
      idx.push(pick);
      const p = PALETTE256[pick]!;
      const er = me[0] - p[0]!;
      const eg = me[1] - p[1]!;
      const eb = me[2] - p[2]!;
      const push = (x: number, y: number, share: number): void => {
        const target = at(x, y);
        if (!target) return;
        target[0] += er * share;
        target[1] += eg * share;
        target[2] += eb * share;
      };
      push(cx + 1, gy, 7 / 16);
      push(cx - 1, gy + 1, 3 / 16);
      push(cx, gy + 1, 5 / 16);
      push(cx + 1, gy + 1, 1 / 16);
    }
  }
  return idx;
}

// Upper-half-block art: each cell carries two vertical pixels (fg = top, bg = bottom).
// Works in every color terminal, including tmux and Terminal.app.
export function halfBlockLines(pixels: RgbaPixels, cols: number, rows: number, depth: ColorDepth = "256"): string[] {
  const gridRows = rows * 2;
  const grid = sampleGrid(pixels, cols, gridRows);
  const lines: string[] = [];
  if (depth === "truecolor") {
    const hex = (c: [number, number, number]): string =>
      Math.max(0, Math.min(255, Math.round(c[0]))) + ";" + Math.max(0, Math.min(255, Math.round(c[1]))) + ";" + Math.max(0, Math.min(255, Math.round(c[2])));
    for (let ry = 0; ry < rows; ry++) {
      let line = "";
      for (let cx = 0; cx < cols; cx++) {
        line += "\x1b[38;2;" + hex(grid[ry * 2 * cols + cx]!) + ";48;2;" + hex(grid[(ry * 2 + 1) * cols + cx]!) + "m▀";
      }
      lines.push(line + "\x1b[0m");
    }
    return lines;
  }
  const idx = dither256(grid, cols, gridRows);
  for (let ry = 0; ry < rows; ry++) {
    let line = "";
    for (let cx = 0; cx < cols; cx++) {
      line += "\x1b[38;5;" + idx[ry * 2 * cols + cx]! + ";48;5;" + idx[(ry * 2 + 1) * cols + cx]! + "m▀";
    }
    lines.push(line + "\x1b[0m");
  }
  return lines;
}

export function itermInline(base64: string, name: string, cols: number, rows: number): string {
  return (
    "\x1b]1337;File=inline=1;preserveAspectRatio=1;doNotMoveCursor=1;size=" +
    decodedBytes(base64) +
    ";width=" +
    cols +
    ";height=" +
    rows +
    ";name=" +
    Buffer.from(name).toString("base64") +
    ":" +
    base64 +
    "\x07"
  );
}

// kitty: `c`/`r` are the display box in cells. (`w`/`h` would crop the source
// to that many *pixels* — the bug that showed a sliver instead of the image.)
export function kittyTransmit(id: number, png: string): string {
  const chunks: string[] = [];
  for (let i = 0; i < png.length; i += KITTY_CHUNK) {
    const more = i + KITTY_CHUNK < png.length ? 1 : 0;
    const control = i === 0 ? "a=t,f=100,t=d,i=" + id + ",q=2," : "q=2,";
    chunks.push("\x1b_G" + control + "m=" + more + ";" + png.slice(i, i + KITTY_CHUNK) + "\x1b\\");
  }
  return chunks.join("");
}

export function kittyPlace(id: number, placement: number, cols: number, rows: number): string {
  return "\x1b_Ga=p,i=" + id + ",p=" + placement + ",c=" + cols + ",r=" + rows + ",C=1,q=2\x1b\\";
}

export const KITTY_CLEAR_PLACEMENTS = "\x1b_Ga=d,d=a,q=2\x1b\\";

export function kittyFree(id: number): string {
  return "\x1b_Ga=d,d=I,i=" + id + ",q=2\x1b\\";
}
