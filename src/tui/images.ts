import { homedir } from "node:os";
import { existsSync } from "node:fs";
import { imageDims, sniffImageMime, type ImageMime } from "../shared/images";
import { ANSI as C } from "../shared/tokens";
import type { Tty } from "./term";
import { decodePng } from "./png";
import { colorDepth, halfBlockLines, type ColorDepth } from "./halfblock";
import { itermImage, kittyShow } from "./protocols";
import { fitCells } from "./thumbs";

const IMAGE_EXT_RE = /(?:[^\s\\]|\\.)+\.(?:png|jpe?g|gif|webp|bmp)/gi;

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
  if (program === "iTerm.app" || program === "WezTerm" || program === "mintty" || env["LC_TERMINAL"] === "iTerm2") return "iterm";
  const term = env["TERM"] ?? "";
  if (env["KITTY_WINDOW_ID"] || env["GHOSTTY_RESOURCES_DIR"] || program === "ghostty" || term.includes("kitty") || term.includes("ghostty")) {
    return "kitty";
  }
  return "none";
}

export function itermImagePayload(image: LoadedImage, widthCells: number, heightRows: number): string {
  return itermImage(image.base64, image.name, widthCells, heightRows, false);
}

export function kittyImagePayload(image: LoadedImage, widthCells: number, heightRows: number): string {
  return kittyShow(image.base64, widthCells, heightRows);
}

function humanSize(bytes: number): string {
  if (bytes >= 1048576) return (bytes / 1048576).toFixed(1) + " MB";
  if (bytes >= 1024) return Math.round(bytes / 1024) + " KB";
  return bytes + " B";
}

export function imageMeta(image: LoadedImage): string {
  const dims = image.width !== null && image.height !== null ? image.width + "×" + image.height : image.mime.replace("image/", "");
  return dims + " · " + humanSize(image.bytes);
}

export function fallbackPanel(image: LoadedImage, width: number, hint = true): string {
  const meta = [imageMeta(image), image.path];
  const lines = [
    "  " + C.teal + "▤ " + C.reset + C.bold + image.name + C.reset,
    "  " + C.dim + trunc(meta.join("  ·  "), width - 4) + C.reset,
  ];
  if (hint) lines.push("  " + C.dim + trunc("inline pixels need iTerm2, WezTerm, kitty or Ghostty — the image still reaches the model", width - 4) + C.reset);
  return lines.join("\n") + "\n";
}

function trunc(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, Math.max(0, max));
}

export function inlineImagePayload(tty: Tty, image: LoadedImage, maxWidthCells: number, maxRowsCells: number, support: ImageSupport): string {
  const cap = Math.max(10, Math.min(maxWidthCells, tty.columns > 0 ? tty.columns - 6 : 60));
  const { cols, rows } = fitCells(image.width ?? 0, image.height ?? 0, cap, Math.max(2, maxRowsCells));
  if (support === "iterm") {
    return itermImagePayload(image, cols, rows);
  }
  if (support === "kitty" && image.mime === "image/png") {
    return kittyImagePayload(image, cols, rows);
  }
  const preview = pixelPreviewLines(image, cols, rows, colorDepth());
  const panel = fallbackPanel(image, tty.columns > 0 ? tty.columns : 80, preview.length === 0);
  return preview.length > 0 ? preview.map((line) => "  " + line).join("\n") + "\n" + panel : panel;
}

export function renderImage(tty: Tty, image: LoadedImage, maxWidthCells = 60, maxHeightCells?: number, support: ImageSupport = imageSupport()): void {
  const heightCap = maxHeightCells ?? Math.max(4, (tty.rows > 0 ? tty.rows : 24) - 4);
  tty.write(inlineImagePayload(tty, image, maxWidthCells, heightCap, support) + "\n");
}

export function pixelPreviewLines(image: LoadedImage, maxCols = 40, maxRows = 12, depth: ColorDepth = "256"): string[] {
  if (image.mime !== "image/png") return [];
  const pixels = decodePng(image.base64);
  if (!pixels) return [];
  const { cols, rows } = fitCells(pixels.width, pixels.height, maxCols, maxRows);
  return halfBlockLines(pixels, cols, Math.max(1, rows), depth);
}
