import { describe, expect, it } from "bun:test";
import { buildPng } from "./helpers/png";
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
});
