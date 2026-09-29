import { inflateSync } from "node:zlib";

export interface RgbaPixels {
  width: number;
  height: number;
  data: Uint8Array;
}

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

export function decodePng(base64: string): RgbaPixels | null {
  const buf = Buffer.from(base64, "base64");
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIG)) return null;
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = -1;
  let interlace = 0;
  const idat: Buffer[] = [];
  let palette: Buffer | null = null;
  let trns: Buffer | null = null;
  while (offset + 8 <= buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.toString("ascii", offset + 4, offset + 8);
    const data = buf.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8]!;
      colorType = data[9]!;
      interlace = data[12]!;
    } else if (type === "PLTE") {
      palette = Buffer.from(data);
    } else if (type === "tRNS") {
      trns = Buffer.from(data);
    } else if (type === "IDAT") {
      idat.push(Buffer.from(data));
    } else if (type === "IEND") {
      break;
    }
    offset += 12 + length;
  }
  if (width <= 0 || height <= 0 || width > 20000 || height > 20000) return null;
  if (bitDepth !== 8 || interlace !== 0) return null;
  if (colorType !== 0 && colorType !== 2 && colorType !== 3 && colorType !== 4 && colorType !== 6) return null;

  const channels = colorType === 0 ? 1 : colorType === 2 ? 3 : colorType === 3 ? 1 : colorType === 4 ? 2 : 4;
  let raw: Buffer;
  try {
    raw = inflateSync(Buffer.concat(idat));
  } catch {
    return null;
  }
  const stride = width * channels;
  if (raw.length < (stride + 1) * height) return null;

  const out = new Uint8Array(width * height * 4);
  let prev = new Uint8Array(stride);
  let pos = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[pos]!;
    pos += 1;
    const line = new Uint8Array(stride);
    for (let x = 0; x < stride; x++) {
      const value = raw[pos]!;
      pos += 1;
      const left = x >= channels ? line[x - channels]! : 0;
      const up = prev[x]!;
      const ul = x >= channels ? prev[x - channels]! : 0;
      let decoded = value;
      if (filter === 1) decoded = value + left;
      else if (filter === 2) decoded = value + up;
      else if (filter === 3) decoded = value + ((left + up) >> 1);
      else if (filter === 4) decoded = value + paeth(left, up, ul);
      line[x] = decoded & 0xff;
    }
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      const i = x * channels;
      if (colorType === 0) {
        const g = line[i]!;
        out[o] = g;
        out[o + 1] = g;
        out[o + 2] = g;
        out[o + 3] = 255;
      } else if (colorType === 2) {
        out[o] = line[i]!;
        out[o + 1] = line[i + 1]!;
        out[o + 2] = line[i + 2]!;
        out[o + 3] = 255;
      } else if (colorType === 3) {
        const idx = line[i]! * 3;
        const pal = palette ?? Buffer.alloc(768);
        out[o] = pal[idx] ?? 0;
        out[o + 1] = pal[idx + 1] ?? 0;
        out[o + 2] = pal[idx + 2] ?? 0;
        out[o + 3] = trns && trns[line[i]!] !== undefined && trns[line[i]!]! < 255 ? 0 : 255;
      } else if (colorType === 4) {
        const g = line[i]!;
        out[o] = g;
        out[o + 1] = g;
        out[o + 2] = g;
        out[o + 3] = line[i + 1]!;
      } else {
        out[o] = line[i]!;
        out[o + 1] = line[i + 1]!;
        out[o + 2] = line[i + 2]!;
        out[o + 3] = line[i + 3]!;
      }
    }
    prev = line;
  }
  return { width, height, data: out };
}
