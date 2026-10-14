import { describe, expect, it } from "bun:test";
import { deflateSync } from "node:zlib";
import { buildPng, chunk } from "./helpers/png";
import { decodePng } from "../src/tui/png";

describe("png decoder", () => {
  it("decodes truecolor pixels with filters applied", () => {
    const png = buildPng(4, 4, (x, y) => [x * 60, y * 60, 128]);
    const pixels = decodePng(png.toString("base64"));
    expect(pixels).not.toBeNull();
    expect(pixels!.width).toBe(4);
    expect(pixels!.height).toBe(4);
    expect([...pixels!.data.slice(0, 3)]).toEqual([0, 0, 128]);
    expect([...pixels!.data.slice((4 * 3 + 3) * 4, (4 * 3 + 3) * 4 + 3)]).toEqual([180, 180, 128]);
  });

  it("rejects non-png payloads", () => {
    expect(decodePng(Buffer.from("not a png").toString("base64"))).toBeNull();
  });

  function grayscalePng(width: number, height: number, inflated: Buffer): string {
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8;
    ihdr[9] = 0;
    const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    return Buffer.concat([
      sig,
      chunk("IHDR", ihdr),
      chunk("IDAT", deflateSync(inflated)),
      chunk("IEND", Buffer.alloc(0)),
    ]).toString("base64");
  }

  it("refuses dimensions past the pixel budget before allocating", () => {
    expect(decodePng(grayscalePng(20000, 20000, Buffer.alloc(16)))).toBeNull();
  });

  it("refuses image data that inflates past the size its header declares", () => {
    const bomb = Buffer.alloc(64 * 1024 * 1024);
    const png = grayscalePng(8, 8, bomb);
    expect(png.length).toBeLessThan(200_000);
    expect(decodePng(png)).toBeNull();
  });
});
