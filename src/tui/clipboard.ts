import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sniffImageMime } from "../shared/images";
import { MAX_IMAGE_BYTES } from "./images";

export type ClipboardRead = () => Promise<Uint8Array>;

function macosSaveScript(dest: string): string {
  return (
    'ObjC.import("AppKit");' +
    "const data = $.NSPasteboard.generalPasteboard.dataForType($.NSPasteboardTypePNG);" +
    'data ? String(data.writeToFileAtomically($("' + dest + '"), true)) : "false"'
  );
}

const EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/bmp": "bmp",
};

async function osascriptWrite(dest: string): Promise<boolean> {
  const proc = Bun.spawn(["osascript", "-l", "JavaScript", "-e", macosSaveScript(dest)], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return proc.exitCode === 0 && out.trim() === "true";
}

async function darwinRead(): Promise<Uint8Array> {
  const scratch = join(tmpdir(), "mimon-clipboard-" + Date.now() + ".png");
  if (!(await osascriptWrite(scratch))) return new Uint8Array();
  try {
    return new Uint8Array(readFileSync(scratch));
  } finally {
    rmSync(scratch, { force: true });
  }
}

async function xclipRead(): Promise<Uint8Array> {
  const proc = Bun.spawn(["xclip", "-selection", "clipboard", "-t", "image/png", "-o"], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const out = new Uint8Array(await new Response(proc.stdout).arrayBuffer());
  await proc.exited;
  return proc.exitCode === 0 ? out : new Uint8Array();
}

export function platformRead(): Promise<Uint8Array> {
  if (process.platform === "darwin") return darwinRead();
  if (process.platform === "linux") return xclipRead();
  return Promise.resolve(new Uint8Array());
}

export async function saveClipboardImage(destDir: string, read: ClipboardRead = platformRead): Promise<string | null> {
  let bytes: Uint8Array;
  try {
    bytes = await read();
  } catch {
    return null;
  }
  if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) return null;
  const base64 = Buffer.from(bytes).toString("base64");
  const mime = sniffImageMime(base64);
  if (!mime) return null;
  mkdirSync(destDir, { recursive: true });
  const path = join(destDir, "pasted-" + Date.now() + "." + (EXTENSIONS[mime] ?? "png"));
  writeFileSync(path, bytes);
  return path;
}
