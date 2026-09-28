import { describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, sep } from "node:path";
import { tmpdir } from "node:os";
import { imageDims, toDataUrl } from "../src/shared/images";
import {
  extractImagePaths,
  imageSupport,
  itermImagePayload,
  kittyImagePayload,
  loadImages,
  renderImage,
  type LoadedImage,
} from "../src/tui/images";
import type { Tty } from "../src/tui/tui";

const PNG_1X1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function base64(bytes: number[]): string {
  return Buffer.from(Uint8Array.from(bytes)).toString("base64");
}

function gifBytes(width: number, height: number): number[] {
  return [0x47, 0x49, 0x46, 0x38, 0x37, 0x61, width & 0xff, width >> 8, height & 0xff, height >> 8, 0x2c, 0x3b];
}

function bmpBytes(width: number, height: number): number[] {
  const header = [0x42, 0x4d, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  const le32 = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff];
  return [...header, ...le32(width), ...le32(height), 0, 0, 1, 0, 24, 0];
}

describe("shared image sniffing", () => {
  it("identifies png, jpeg, gif, webp and bmp by magic bytes", async () => {
    const { sniffImageMime } = await import("../src/shared/images");
    expect(sniffImageMime(PNG_1X1)).toBe("image/png");
    expect(sniffImageMime(base64([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]))).toBe("image/jpeg");
    expect(sniffImageMime(base64(gifBytes(5, 7)))).toBe("image/gif");
    expect(sniffImageMime(base64([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x58]))).toBe("image/webp");
    expect(sniffImageMime(base64(bmpBytes(3, 2)))).toBe("image/bmp");
    expect(sniffImageMime("bm90IGFuIGltYWdl")).toBeNull();
    expect(sniffImageMime("")).toBeNull();
  });

  it("accepts data URLs and strips them", () => {
    const { sniffImageMime, stripDataUrl } = require("../src/shared/images");
    const dataUrl = toDataUrl("image/png", PNG_1X1);
    expect(sniffImageMime(dataUrl)).toBe("image/png");
    expect(stripDataUrl(dataUrl)).toBe(PNG_1X1);
    expect(stripDataUrl(PNG_1X1)).toBe(PNG_1X1);
  });

  it("reads dimensions for png, gif and bmp", () => {
    expect(imageDims(PNG_1X1)).toEqual({ width: 1, height: 1 });
    expect(imageDims(base64(gifBytes(5, 7)))).toEqual({ width: 5, height: 7 });
    expect(imageDims(base64(bmpBytes(3, 2)))).toEqual({ width: 3, height: 2 });
    expect(imageDims("bm90IGFuIGltYWdl")).toBeNull();
  });
});

describe("extractImagePaths", () => {
  it("finds absolute image paths in free text", () => {
    expect(extractImagePaths("look at /tmp/shot.png and tell me")).toEqual(["/tmp/shot.png"]);
    expect(extractImagePaths("no images here")).toEqual([]);
    expect(extractImagePaths("two: /a/x.png, /b/y.jpg")).toEqual(["/a/x.png", "/b/y.jpg"]);
  });

  it("unescapes dropped paths, strips trailing punctuation and expands ~", () => {
    expect(extractImagePaths("/Users/mo/my\\ cat.png")).toEqual(["/Users/mo/my cat.png"]);
    expect(extractImagePaths("(/tmp/a.png),")).toEqual(["/tmp/a.png"]);
    expect(extractImagePaths("~/notes/photo.jpeg")).toEqual([homedir() + sep + "notes" + sep + "photo.jpeg"]);
  });

  it("deduplicates repeated paths", () => {
    expect(extractImagePaths("/a.png and again /a.png")).toEqual(["/a.png"]);
  });
});

describe("loadImages", () => {
  const dir = join(tmpdir(), "mimon-images-test-" + process.pid);

  it("loads existing images with mime, size and dims", async () => {
    mkdirSync(dir, { recursive: true });
    const pngPath = join(dir, "tiny.png");
    writeFileSync(pngPath, Buffer.from(PNG_1X1, "base64"));
    const { images, errors } = await loadImages("what is in " + pngPath + " exactly");
    expect(errors).toEqual([]);
    expect(images).toHaveLength(1);
    expect(images[0]!.mime).toBe("image/png");
    expect(images[0]!.width).toBe(1);
    expect(images[0]!.height).toBe(1);
    expect(images[0]!.bytes).toBeGreaterThan(0);
  });

  it("reports missing files and non-images instead of throwing", async () => {
    mkdirSync(dir, { recursive: true });
    const fakePath = join(dir, "note.png");
    writeFileSync(fakePath, "just text, not an image");
    const { images, errors } = await loadImages("/nope/missing.png " + fakePath);
    expect(images).toEqual([]);
    expect(errors).toHaveLength(2);
    expect(errors[0]).toContain("not found");
    expect(errors[1]).toContain("not a readable image");
  });

  it("caps the number of images per message", async () => {
    mkdirSync(dir, { recursive: true });
    const paths: string[] = [];
    for (let i = 0; i < 6; i++) {
      const p = join(dir, "img" + i + ".png");
      writeFileSync(p, Buffer.from(PNG_1X1, "base64"));
      paths.push(p);
    }
    const { images, errors } = await loadImages(paths.join(" "));
    expect(images).toHaveLength(4);
    expect(errors).toHaveLength(2);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("terminal image protocols", () => {
  const image: LoadedImage = {
    path: "/tmp/shot.png",
    name: "shot.png",
    mime: "image/png",
    base64: PNG_1X1,
    bytes: 1234,
    width: 1,
    height: 1,
  };

  it("detects iterm, kitty, ghostty and unsupported terminals", () => {
    expect(imageSupport({ TERM_PROGRAM: "iTerm.app" })).toBe("iterm");
    expect(imageSupport({ TERM_PROGRAM: "WezTerm" })).toBe("iterm");
    expect(imageSupport({ TERM_PROGRAM: "mintty", TERM: "xterm-256color" })).toBe("iterm");
    expect(imageSupport({ TERM: "xterm-kitty" })).toBe("kitty");
    expect(imageSupport({ KITTY_WINDOW_ID: "1" })).toBe("kitty");
    expect(imageSupport({ GHOSTTY_RESOURCES_DIR: "/x", TERM: "xterm-256color" })).toBe("kitty");
    expect(imageSupport({ TERM: "xterm-256color" })).toBe("none");
    expect(imageSupport({ TERM_PROGRAM: "iTerm.app", TMUX: "/tmp/tmux-0/default,1,0" })).toBe("none");
    expect(imageSupport({ TERM: "screen-256color", TMUX: "1" })).toBe("none");
  });

  it("builds an iTerm inline-image escape with width and size", () => {
    const payload = itermImagePayload(image, 40);
    expect(payload.startsWith("\x1b]1337;File=inline=1;")).toBe(true);
    expect(payload).toContain("preserveAspectRatio=1");
    expect(payload).toContain("size=1234");
    expect(payload).toContain("width=40");
    expect(payload.endsWith("\x07")).toBe(true);
    expect(payload).toContain(":" + PNG_1X1);
  });

  it("chunks the kitty payload at 4096 base64 chars with m flags", () => {
    const big: LoadedImage = { ...image, base64: "A".repeat(5000) };
    const payload = kittyImagePayload(big, 30);
    const chunks = payload.split("\x1b\\").filter((c) => c.length > 0);
    expect(chunks.length).toBe(2);
    expect(chunks[0]).toContain("f=100,a=T,q=2,c=30,m=1;");
    expect(chunks[1]).toContain("m=0;");
    const small = kittyImagePayload(image, 30);
    expect(small).toContain("m=0;");
    expect(small).not.toContain("m=1;");
  });

  it("falls back to a metadata panel without dumping raw bytes", () => {
    class MockTty implements Tty {
      chunks: string[] = [];
      columns = 80;
      rows = 24;
      write(data: string): void {
        this.chunks.push(data);
      }
      text(): string {
        return this.chunks.join("");
      }
    }
    const tty = new MockTty();
    renderImage(tty, image, 60);
    const t = tty.text();
    expect(t).toContain("shot.png");
    expect(t).toContain("1×1");
    expect(t).toContain("inline pixels need iTerm2");
    expect(t).not.toContain(PNG_1X1);
  });
});
