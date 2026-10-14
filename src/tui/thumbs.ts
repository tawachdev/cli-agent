import { deflateSync } from "node:zlib";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodePng, type RgbaPixels } from "./png";
import type { LoadedImage } from "./images";

const PROTOCOL_EDGE = 480;
const ORIGINAL_INLINE_CAP = 2 * 1024 * 1024;

export interface Thumb {
  id: number;
  width: number;
  height: number;
  pixels: RgbaPixels | null;
  png: string | null;
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

export const defaultToPng: ToPng = (path) =>
  process.platform === "darwin" ? sipsToPng(path) : Promise.resolve(null);

async function decodeAny(image: LoadedImage, toPng: ToPng): Promise<RgbaPixels | null> {
  if (image.mime === "image/png") return decodePng(image.base64);
  const converted = await toPng(image.path).catch(() => null);
  return converted && converted.length > 0 ? decodePng(Buffer.from(converted).toString("base64")) : null;
}

export async function makeThumb(image: LoadedImage, toPng: ToPng = defaultToPng): Promise<Thumb> {
  const decoded = await decodeAny(image, toPng);
  const small = decoded ? downscale(decoded, PROTOCOL_EDGE) : null;
  const original = image.bytes <= ORIGINAL_INLINE_CAP ? image.base64 : null;
  const originalPng = image.mime === "image/png" ? original : null;
  let png: string | null;
  if (!small) png = originalPng;
  else if (small === decoded && originalPng) png = originalPng;
  else png = encodePng(small).toString("base64");
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
