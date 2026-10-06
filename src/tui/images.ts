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

export function itermImagePayload(image: LoadedImage, widthCells: number): string {
  const name = Buffer.from(image.name).toString("base64");
  return (
    "\x1b]1337;File=inline=1;preserveAspectRatio=1;size=" +
    image.bytes +
    ";width=" +
    widthCells +
    ";name=" +
    name +
    ":" +
    image.base64 +
    "\x07"
  );
}

export function kittyImagePayload(image: LoadedImage, widthCells: number): string {
  const chunks: string[] = [];
  for (let i = 0; i < image.base64.length; i += KITTY_CHUNK) {
    const last = i + KITTY_CHUNK >= image.base64.length;
    const control = i === 0 ? "f=100,a=T,q=2,c=" + widthCells + "," : "q=2,";
    chunks.push("\x1b_G" + control + "m=" + (last ? 0 : 1) + ";" + image.base64.slice(i, i + KITTY_CHUNK) + "\x1b\\");
  }
  if (chunks.length === 0) chunks.push("\x1b_Gf=100,a=T,q=2,c=" + widthCells + ",m=0;\x1b\\");
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

export function renderImage(tty: Tty, image: LoadedImage, maxWidthCells = 60): void {
  const width = Math.max(10, Math.min(maxWidthCells, tty.columns > 0 ? tty.columns - 6 : 60));
  const support = imageSupport();
  if (support === "iterm") {
    tty.write(itermImagePayload(image, width) + "\n");
  } else if (support === "kitty") {
    tty.write(kittyImagePayload(image, width) + "\n");
  } else {
    tty.write(fallbackPanel(image, tty.columns > 0 ? tty.columns : 80));
  }
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
  const boost = (color: [number, number, number]): [number, number, number] => {
    const lum = 0.3 * color[0]! + 0.6 * color[1]! + 0.1 * color[2]!;
    return [
      Math.max(0, Math.min(255, Math.round(lum + (color[0]! - lum) * 1.4))),
      Math.max(0, Math.min(255, Math.round(lum + (color[1]! - lum) * 1.4))),
      Math.max(0, Math.min(255, Math.round(lum + (color[2]! - lum) * 1.4))),
    ];
  };
  const regionColor = (x0: number, y0: number, x1: number, y1: number): [number, number, number] => {
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
    if (n === 0) return [0, 0, 0];
    return boost([Math.round(r / n), Math.round(g / n), Math.round(b / n)]);
  };
  const lines: string[] = [];
  for (let ry = 0; ry < rows; ry++) {
    let line = "";
    for (let cx = 0; cx < cols; cx++) {
      const x0 = cx * pixels.width / cols;
      const x1 = (cx + 1) * pixels.width / cols;
      const top = regionColor(x0, ry * 2 * pixels.height / (rows * 2), x1, (ry * 2 + 1) * pixels.height / (rows * 2));
      const bot = regionColor(x0, (ry * 2 + 1) * pixels.height / (rows * 2), x1, (ry * 2 + 2) * pixels.height / (rows * 2));
      line +=
        "\x1b[38;2;" + top[0] + ";" + top[1] + ";" + top[2] +
        ";48;2;" + bot[0] + ";" + bot[1] + ";" + bot[2] + "m▀";
    }
    lines.push(line + C.reset);
  }
  return lines;
}
