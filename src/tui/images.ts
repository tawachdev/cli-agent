import { homedir } from "node:os";
import { imageDims, sniffImageMime, type ImageMime } from "../shared/images";
import { C, type Tty } from "./tui";

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

export function extractImagePaths(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(IMAGE_EXT_RE)) {
    const raw = match[0].replace(/\\(.)/g, "$1").replace(/^[("']+/, "").replace(/[),.;:!?]+"?$/, "");
    const expanded = raw.startsWith("~") ? homedir() + raw.slice(1) : raw;
    if (!found.includes(expanded)) found.push(expanded);
  }
  return found;
}

export async function loadImages(text: string): Promise<{ images: LoadedImage[]; errors: string[] }> {
  const images: LoadedImage[] = [];
  const errors: string[] = [];
  for (const path of extractImagePaths(text)) {
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
