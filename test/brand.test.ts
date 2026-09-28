import { describe, expect, it } from "bun:test";
import { brandName, DEFAULT_BRAND, entryColor, validColorEntry, xterm256Hex } from "../src/shared/brand";
import { glyphWord, MINI_GLYPHS, WIDE_GLYPHS } from "../src/shared/glyphs";
import { splash, visibleLen, type Tty } from "../src/tui/tui";

class MockTty implements Tty {
  chunks: string[] = [];
  columns = 100;
  rows = 30;
  write(data: string): void {
    this.chunks.push(data);
  }
  text(): string {
    return this.chunks.join("").replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
  }
}

describe("brand resolution", () => {
  it("defaults to MIMON without an env override", () => {
    expect(brandName({})).toBe("MIMON");
    expect(DEFAULT_BRAND).toBe("MIMON");
  });

  it("accepts a valid AGENT_NAME in any case", () => {
    expect(brandName({ AGENT_NAME: "anir" })).toBe("ANIR");
    expect(brandName({ AGENT_NAME: "Adnane" })).toBe("ADNANE");
  });

  it("rejects junk names and falls back to the default", () => {
    expect(brandName({ AGENT_NAME: "" })).toBe("MIMON");
    expect(brandName({ AGENT_NAME: "A" })).toBe("MIMON");
    expect(brandName({ AGENT_NAME: "HAS SPACE" })).toBe("MIMON");
    expect(brandName({ AGENT_NAME: "AB--CD" })).toBe("MIMON");
    expect(brandName({ AGENT_NAME: "A1234567890123" })).toBe("MIMON");
  });
});

describe("pixel font", () => {
  it("covers every letter A-Z in both sizes", () => {
    for (const letter of "ABCDEFGHIJKLMNOPQRSTUVWXYZ") {
      expect(WIDE_GLYPHS[letter]).toBeDefined();
      expect(MINI_GLYPHS[letter]).toBeDefined();
    }
  });

  it("keeps a consistent row count and width per glyph", () => {
    for (const font of [WIDE_GLYPHS, MINI_GLYPHS]) {
      for (const rows of Object.values(font)) {
        expect(rows.length).toBe(font === WIDE_GLYPHS ? 6 : 4);
        const width = rows[0]!.length;
        for (const row of rows) expect(row.length).toBe(width);
      }
    }
  });

  it("keeps MIMON pixel-identical to the original hand-drawn letters", () => {
    const wide = glyphWord("MIMON", false);
    expect(wide?.rows[2]).toContain("██ ██ ██");
    expect(wide?.width).toBe(43);
    const mini = glyphWord("MIMON", true);
    expect(mini?.rows[2]).toContain("█ █ █");
  });

  it("builds any name from the font", () => {
    const word = glyphWord("ANIR", false);
    expect(word).not.toBeNull();
    expect(word!.cells[0]).toHaveLength(4);
    expect(word!.rows).toHaveLength(6);
    expect(glyphWord("AN1R", false)).toBeNull();
    expect(glyphWord("", false)).toBeNull();
  });
});

describe("rebranded splash", () => {
  it("renders the custom name letters in the boot box", () => {
    process.env.AGENT_NAME = "ANIR";
    try {
      const tty = new MockTty();
      tty.columns = 100;
      splash(tty, "0.2.0");
      const t = tty.text();
      expect(t).toContain("╭");
      expect(t).toContain("v0.2.0 · fully local");
      const word = glyphWord("ANIR", false)!;
      for (const row of word.rows) {
        expect(t).toContain(row);
      }
    } finally {
      delete process.env.AGENT_NAME;
    }
  });

  it("keeps every splash line inside the terminal width for a long name", () => {
    process.env.AGENT_NAME = "KINGSDREAD";
    try {
      for (const columns of [40, 60, 100, 140]) {
        const tty = new MockTty();
        tty.columns = columns;
        splash(tty, "0.2.0");
        for (const line of tty.chunks.join("").split("\n")) {
          expect(visibleLen(line.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ""))).toBeLessThanOrEqual(columns - 1);
        }
      }
    } finally {
      delete process.env.AGENT_NAME;
    }
  });
});

describe("custom hex colors", () => {
  it("accepts #rrggbb and normalizes it", () => {
    expect(validColorEntry("#00FF88")).toBe("#00ff88");
    expect(validColorEntry("00ff88")).toBe("#00ff88");
    expect(validColorEntry("teal")).toBe("teal");
    expect(validColorEntry("#00ff8")).toBeNull();
    expect(validColorEntry("#zzzzzz")).toBeNull();
    expect(validColorEntry("")).toBeNull();
  });

  it("renders hex as a truecolor escape", () => {
    expect(entryColor("#ff8800")).toBe("\x1b[38;2;255;136;0m");
    expect(entryColor("teal")).toBe("\x1b[38;5;37m");
  });
});

describe("xterm256Hex", () => {
  it("maps cube, base and gray ramp indexes to hex", () => {
    expect(xterm256Hex(16)).toBe("#000000");
    expect(xterm256Hex(21)).toBe("#0000ff");
    expect(xterm256Hex(201)).toBe("#ff00ff");
    expect(xterm256Hex(244)).toBe("#808080");
    expect(xterm256Hex(231)).toBe("#ffffff");
    expect(xterm256Hex(255)).toBe("#eeeeee");
    expect(xterm256Hex(300)).toBe("#eeeeee");
  });
});
