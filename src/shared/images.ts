export type ImageMime = "image/png" | "image/jpeg" | "image/gif" | "image/webp" | "image/bmp";

const DATA_URL_RE = /^data:(image\/[a-z0-9.+-]+);base64,/i;

const MAGICS: Array<{ mime: ImageMime; test: (b: Uint8Array) => boolean }> = [
  { mime: "image/png", test: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  { mime: "image/jpeg", test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: "image/gif", test: (b) => b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38 },
  {
    mime: "image/webp",
    test: (b) => b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50,
  },
  { mime: "image/bmp", test: (b) => b[0] === 0x42 && b[1] === 0x4d },
];

export function stripDataUrl(source: string): string {
  const match = DATA_URL_RE.exec(source);
  return match ? source.slice(match[0].length) : source;
}

export function toDataUrl(mime: ImageMime, rawBase64: string): string {
  return `data:${mime};base64,${rawBase64}`;
}

function decodePrefix(base64: string, byteCount: number): Uint8Array | null {
  const slice = base64.slice(0, Math.ceil(byteCount / 3) * 4 + 4);
  try {
    const binary = atob(slice);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

export function sniffImageMime(source: string): ImageMime | null {
  const bytes = decodePrefix(stripDataUrl(source), 32);
  if (!bytes || bytes.length < 12) return null;
  return MAGICS.find((magic) => magic.test(bytes))?.mime ?? null;
}

const le16 = (b: Uint8Array, i: number): number => b[i]! | (b[i + 1]! << 8);
const le24 = (b: Uint8Array, i: number): number => le16(b, i) | (b[i + 2]! << 16);
const be16 = (b: Uint8Array, i: number): number => (b[i]! << 8) | b[i + 1]!;
const le32 = (b: Uint8Array, i: number): number => le24(b, i) | (b[i + 3]! << 24);
const be32 = (b: Uint8Array, i: number): number => (be16(b, i) << 16) | be16(b, i + 2);

function pngDims(b: Uint8Array): { width: number; height: number } | null {
  if (b.length < 24) return null;
  return { width: be32(b, 16), height: be32(b, 20) };
}

function gifDims(b: Uint8Array): { width: number; height: number } | null {
  if (b.length < 10) return null;
  return { width: le16(b, 6), height: le16(b, 8) };
}

function bmpDims(b: Uint8Array): { width: number; height: number } | null {
  if (b.length < 26) return null;
  return { width: le32(b, 18), height: Math.abs(le32(b, 22)) };
}

function jpegDims(b: Uint8Array): { width: number; height: number } | null {
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) return null;
    const marker = b[i + 1]!;
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    const length = be16(b, i + 2);
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) return { width: be16(b, i + 7), height: be16(b, i + 5) };
    i += 2 + length;
  }
  return null;
}

function webpDims(b: Uint8Array): { width: number; height: number } | null {
  if (b.length < 30) return null;
  const chunk = String.fromCharCode(b[12]!, b[13]!, b[14]!, b[15]!);
  if (chunk === "VP8 ") return { width: le16(b, 26) & 0x3fff, height: le16(b, 28) & 0x3fff };
  if (chunk === "VP8L") {
    const bits = le32(b, 21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (chunk === "VP8X") return { width: le24(b, 24) + 1, height: le24(b, 27) + 1 };
  return null;
}

export function imageDims(source: string): { width: number; height: number } | null {
  const mime = sniffImageMime(source);
  if (!mime) return null;
  const bytes = decodePrefix(stripDataUrl(source), 256 * 1024);
  if (!bytes) return null;
  if (mime === "image/png") return pngDims(bytes);
  if (mime === "image/gif") return gifDims(bytes);
  if (mime === "image/bmp") return bmpDims(bytes);
  if (mime === "image/jpeg") return jpegDims(bytes);
  return webpDims(bytes);
}
