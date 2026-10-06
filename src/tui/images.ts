import { homedir } from "node:os";
import { existsSync } from "node:fs";
import { imageDims, sniffImageMime, type ImageMime } from "../shared/images";
import { C, type Tty } from "./tui";
import { decodePng } from "./png";

const IMAGE_EXT_RE = /(?:[^\s\\]|\\.)+\.(?:png|jpe?g|gif|webp|bmp)/gi;
const KITTY_CHUNK = 4096;

export const MAX_IMAGES = 4;
export const MAX_IMAGE_BYTES = 6 * 1024 * 1024;

export interface LoadedImage {
  path: string;
  name: string;
  mime: ImageMime;
  base64: string;
  bytes: number;
  width: number | null;
  height: number | null;
}

export interface LocatedImage {
  start: number;
  end: number;
  path: string;
}

function expandHome(p: string): string {
  return p.startsWith("~") ? homedir() + p.slice(1) : p;
}

export function locateImagePaths(text: string): LocatedImage[] {
  const found: LocatedImage[] = [];
  for (const match of text.matchAll(IMAGE_EXT_RE)) {
    let start = match.index;
    let original = match[0];
    let scanStart = match.index;
    for (let guard = 0; guard < 8; guard++) {
      if (scanStart === 0 || text[scanStart - 1] !== " ") break;
      let w = scanStart - 1;
      while (w > 0 && /\S/.test(text[w - 1]!)) w--;
      const candidate = text.slice(w, match.index + match[0].length);
      const unescaped = candidate.replace(/\\(.)/g, "$1");
      const looksPath = candidate.startsWith("/") || candidate.startsWith("~/") || candidate.startsWith("./");
      const pastePromise = unescaped.includes("/TemporaryItems/");
      if (looksPath && (pastePromise || existsSync(expandHome(unescaped)))) {
        start = w;
        original = candidate;
      }
      scanStart = w;
    }
    const raw = original.replace(/\\(.)/g, "$1").replace(/^[("']+/, "").replace(/[),.;:!?]+"?$/, "");
    if (!raw) continue;
    let cursor = 0;
    while (cursor < original.length && /[("']/.test(original[cursor]!)) cursor++;
    const locatedStart = start + cursor;
    let rawIndex = 0;
    let end = locatedStart;
    let scan = cursor;
    while (scan < original.length && rawIndex < raw.length) {
      scan += original[scan] === "\\" && scan + 1 < original.length ? 2 : 1;
      rawIndex += 1;
      end = start + scan;
    }
    const expanded = expandHome(raw);
    if (!found.some((f) => f.path === expanded)) found.push({ start: locatedStart, end, path: expanded });
  }
  return found;
}

export function extractImagePaths(text: string): string[] {
  return locateImagePaths(text).map((located) => located.path);
}

export function imageChipName(path: string): string {
  return path.replace(/\/+$/, "").split("/").pop() ?? path;
}

export async function loadImagesFromPaths(paths: string[]): Promise<{ images: LoadedImage[]; errors: string[] }> {
  const images: LoadedImage[] = [];
  const errors: string[] = [];
  for (const path of paths) {
    if (images.some((image) => image.path === path)) continue;
    if (images.length >= MAX_IMAGES) {
      errors.push(path + " — skipped, max " + MAX_IMAGES + " images per message");
      continue;
    }
    try {
      const file = Bun.file(path);
      if (!(await file.exists())) {
        errors.push(path + " — not found, skipped (drop the file into the terminal or use its full path)");
        continue;
      }
      if (file.size > MAX_IMAGE_BYTES) {
        errors.push(path + " — too large (" + (file.size / 1048576).toFixed(1) + " MB, max 6 MB)");
        continue;
      }
      const base64 = Buffer.from(await file.arrayBuffer()).toString("base64");
      const mime = sniffImageMime(base64);
      if (!mime) {
        errors.push(path + " — not a readable image, skipped");
        continue;
      }
      const dims = imageDims(base64);
      images.push({
        path,
        name: path.replace(/\/+$/, "").split("/").pop() ?? path,
        mime,
        base64,
        bytes: file.size,
        width: dims?.width ?? null,
        height: dims?.height ?? null,
      });
    } catch {
      errors.push(path + " — could not be read, skipped");
    }
  }
  return { images, errors };
}

export async function loadImages(text: string): Promise<{ images: LoadedImage[]; errors: string[] }> {
  return loadImagesFromPaths(extractImagePaths(text));
}

export type ImageSupport = "iterm" | "kitty" | "none";

export function imageSupport(env: Record<string, string | undefined> = process.env): ImageSupport {
  if (env["TMUX"]) return "none";
  const program = env["TERM_PROGRAM"] ?? "";
  if (program === "iTerm.app" || program === "WezTerm" || program === "mintty") return "iterm";
  const term = env["TERM"] ?? "";
  if (env["KITTY_WINDOW_ID"] || env["GHOSTTY_RESOURCES_DIR"] || term.includes("kitty") || term.includes("ghostty")) {
    return "kitty";
  }
  return "none";
}

export function itermImagePayload(image: LoadedImage, cells: number, byHeight = false): string {
  const name = Buffer.from(image.name).toString("base64");
  return (
    "\x1b]1337;File=inline=1;preserveAspectRatio=1;size=" +
    image.bytes +
    ";" +
    (byHeight ? "height=" : "width=") +
    cells +
    ";name=" +
    name +
    ":" +
    image.base64 +
    "\x07"
  );
}

export function kittyImagePayload(image: LoadedImage, cells: number, byHeight = false): string {
  const chunks: string[] = [];
  const geometry = byHeight ? "r=" + cells + "," : "c=" + cells + ",";
  for (let i = 0; i < image.base64.length; i += KITTY_CHUNK) {
    const last = i + KITTY_CHUNK >= image.base64.length;
    const control = i === 0 ? "f=100,a=T,q=2," + geometry : "q=2,";
    chunks.push("\x1b_G" + control + "m=" + (last ? 0 : 1) + ";" + image.base64.slice(i, i + KITTY_CHUNK) + "\x1b\\");
  }
  if (chunks.length === 0) chunks.push("\x1b_Gf=100,a=T,q=2," + geometry + "m=0;\x1b\\");
  return chunks.join("");
}

function humanSize(bytes: number): string {
  if (bytes >= 1048576) return (bytes / 1048576).toFixed(1) + " MB";
  if (bytes >= 1024) return Math.round(bytes / 1024) + " KB";
  return bytes + " B";
}

function fallbackPanel(image: LoadedImage, width: number): string {
  const dims = image.width !== null && image.height !== null ? image.width + "×" + image.height : image.mime;
  const meta = [dims, humanSize(image.bytes), image.path];
  const lines = [
    "  " + C.teal + "▤ " + C.reset + C.bold + image.name + C.reset,
    "  " + C.dim + trunc(meta.join("  ·  "), width - 4) + C.reset,
    "  " + C.dim + trunc("inline pixels need iTerm2, WezTerm, kitty or Ghostty — the image still reaches the model", width - 4) + C.reset,
  ];
  return lines.join("\n") + "\n";
}

function trunc(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, Math.max(0, max));
}

export function renderImage(tty: Tty, image: LoadedImage, maxWidthCells = 60, maxHeightCells?: number, support: ImageSupport = imageSupport()): void {
  let width = Math.max(10, Math.min(maxWidthCells, tty.columns > 0 ? tty.columns - 6 : 60));
  let byHeight = false;
  if (maxHeightCells !== undefined && image.width !== null && image.height !== null && image.height > 0) {
    const rows = Math.round((width * image.height) / image.width);
    if (rows > maxHeightCells) byHeight = true;
  }
  if (support === "iterm") {
    tty.write(itermImagePayload(image, byHeight ? maxHeightCells! : width, byHeight) + "\n");
  } else if (support === "kitty") {
    tty.write(kittyImagePayload(image, byHeight ? maxHeightCells! : width, byHeight) + "\n");
  } else {
    tty.write(fallbackPanel(image, tty.columns > 0 ? tty.columns : 80));
  }
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

export function pixelPreviewLines(image: LoadedImage, maxCols = 40, maxRows = 12): string[] {
  if (image.mime !== "image/png") return [];
  const pixels = decodePng(image.base64);
  if (!pixels) return [];
  const ratio = pixels.width / pixels.height;
  let cols = Math.min(maxCols, Math.max(8, Math.round(maxRows * 2 * ratio)));
  let rows = Math.max(2, Math.round(cols / (2 * ratio)));
  if (rows > maxRows) {
    rows = maxRows;
    cols = Math.max(8, Math.round(rows * 2 * ratio));
  }
  const gridRows = rows * 2;
  const grid: Array<[number, number, number]> = [];
  for (let gy = 0; gy < gridRows; gy++) {
    for (let cx = 0; cx < cols; cx++) {
      const x0 = cx * pixels.width / cols;
      const x1 = (cx + 1) * pixels.width / cols;
      const y0 = gy * pixels.height / gridRows;
      const y1 = (gy + 1) * pixels.height / gridRows;
      const sx0 = Math.max(0, Math.floor(x0));
      const sy0 = Math.max(0, Math.floor(y0));
      const sx1 = Math.min(pixels.width, Math.ceil(x1));
      const sy1 = Math.min(pixels.height, Math.ceil(y1));
      const stride = Math.max(1, Math.floor(Math.max(sx1 - sx0, sy1 - sy0) / 24));
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      for (let y = sy0; y < sy1; y += stride) {
        for (let x = sx0; x < sx1; x += stride) {
          const o = (y * pixels.width + x) * 4;
          r += pixels.data[o]!;
          g += pixels.data[o + 1]!;
          b += pixels.data[o + 2]!;
          n += 1;
        }
      }
      grid.push(n === 0 ? [0, 0, 0] : [r / n, g / n, b / n]);
    }
  }
  const idx: number[] = [];
  for (let gy = 0; gy < gridRows; gy++) {
    for (let cx = 0; cx < cols; cx++) {
      const at = (x: number, y: number): [number, number, number] | null =>
        x < 0 || x >= cols || y >= gridRows ? null : grid[y * cols + x]!;
      const me = at(cx, gy)!;
      const pick = nearestPaletteIndex(
        Math.max(0, Math.min(255, Math.round(me[0]!))),
        Math.max(0, Math.min(255, Math.round(me[1]!))),
        Math.max(0, Math.min(255, Math.round(me[2]!))),
      );
      idx.push(pick);
      const p = PALETTE256[pick]!;
      const er = me[0]! - p[0]!;
      const eg = me[1]! - p[1]!;
      const eb = me[2]! - p[2]!;
      const push = (x: number, y: number, share: number): void => {
        const target = at(x, y);
        if (target) {
          target[0] = target[0]! + (er * share);
          target[1] = target[1]! + (eg * share);
          target[2] = target[2]! + (eb * share);
        }
      };
      push(cx + 1, gy, 7 / 16);
      push(cx - 1, gy + 1, 3 / 16);
      push(cx, gy + 1, 5 / 16);
      push(cx + 1, gy + 1, 1 / 16);
    }
  }
  const lines: string[] = [];
  for (let ry = 0; ry < rows; ry++) {
    let line = "";
    for (let cx = 0; cx < cols; cx++) {
      const top = idx[ry * 2 * cols + cx]!;
      const bot = idx[(ry * 2 + 1) * cols + cx]!;
      line += "\x1b[38;5;" + top + ";48;5;" + bot + "m▀";
    }
    lines.push(line + C.reset);
  }
  return lines;
}
