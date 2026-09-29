import { describe, expect, it } from "bun:test";
import { Chat } from "../src/tui/chat";
import { brandName } from "../src/shared/brand";
import { glyphWord } from "../src/shared/glyphs";
import { Tui, type Key, type Tty } from "../src/tui/tui";

class VirtualTerminal {
  cols: number;
  rows: number;
  private grid: string[][] = [];
  row = 0;
  col = 0;

  constructor(rows: number, cols: number) {
    this.rows = rows;
    this.cols = cols;
    this.clearAll();
  }

  resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
    this.row = Math.min(this.row, rows - 1);
    this.col = Math.min(this.col, cols - 1);
  }

  private clearAll(): void {
    this.grid = [];
    for (let r = 0; r < this.rows; r++) this.grid.push(this.blankRow());
    this.row = 0;
    this.col = 0;
  }

  private blankRow(): string[] {
    return new Array<string>(this.cols).fill(" ");
  }

  private scrollUp(): void {
    this.grid.shift();
    this.grid.push(this.blankRow());
  }

  private lineFeed(): void {
    if (this.row + 1 >= this.rows) {
      this.scrollUp();
      return;
    }
    this.row += 1;
  }

  private clearFromCursor(): void {
    for (let c = this.col; c < this.cols; c++) this.grid[this.row]![c] = " ";
    for (let r = this.row + 1; r < this.rows; r++) this.grid[r] = this.blankRow();
  }

  private clearLineFromCursor(): void {
    for (let c = this.col; c < this.cols; c++) this.grid[this.row]![c] = " ";
  }

  private put(ch: string): void {
    if (this.col >= this.cols) {
      this.col = 0;
      this.lineFeed();
    }
    this.grid[this.row]![this.col] = ch;
    this.col += 1;
  }

  private csi(params: string, final: string): void {
    if (final === "m") return;
    const n = params === "" || Number.isNaN(parseInt(params, 10)) ? 1 : parseInt(params, 10);
    if (final === "A") this.row = Math.max(0, this.row - n);
    else if (final === "B") for (let i = 0; i < n; i++) this.lineFeed();
    else if (final === "C") this.col = Math.min(this.cols - 1, this.col + n);
    else if (final === "D") this.col = Math.max(0, this.col - n);
    else if (final === "J") {
      if (params === "2") this.clearAll();
      else this.clearFromCursor();
    } else if (final === "K") this.clearLineFromCursor();
    else if (final === "H") {
      const parts = params.split(";");
      const r = parts[0] ? parseInt(parts[0], 10) : 0;
      const c = parts[1] ? parseInt(parts[1], 10) : 0;
      this.row = Math.min(this.rows - 1, Math.max(0, r - 1));
      this.col = Math.min(this.cols - 1, Math.max(0, c - 1));
    }
  }

  fullClears = 0;
  feed(data: string): void {
    this.fullClears += (data.match(/\x1b\[2J/g) ?? []).length;
    let i = 0;
    while (i < data.length) {
      const ch = data[i]!;
      if (ch === "\x1b") {
        const tail = data.slice(i);
        const match = tail.match(/^\x1b\[([0-9;?<>=]*)([A-Za-z])/);
        if (match) {
          this.csi(match[1]!, match[2]!);
          i += match[0].length;
          continue;
        }
        i += 1;
        continue;
      }
      if (ch === "\r") {
        this.col = 0;
        i += 1;
        continue;
      }
      if (ch === "\n") {
        this.lineFeed();
        i += 1;
        continue;
      }
      if (ch === "\x07" || ch === "\x08") {
        i += 1;
        continue;
      }
      this.put(ch);
      i += 1;
    }
  }

  screen(): string {
    return this.grid.map((r) => r.join("").replace(/\s+$/, "")).join("\n");
  }

  count(needle: string): number {
    return this.screen().split(needle).length - 1;
  }

  asTty(): Tty {
    const vt = this;
    return {
      write: (data) => vt.feed(data),
      get columns() {
        return vt.cols;
      },
      get rows() {
        return vt.rows;
      },
    };
  }
}

interface Captured {
  submitted: string[];
  commands: string[];
  tiers: string[];
  aborted: number;
  exited: number;
}

function makeVt(rows: number, cols: number): { vt: VirtualTerminal; tui: Tui; cap: Captured } {
  const vt = new VirtualTerminal(rows, cols);
  const cap: Captured = { submitted: [], commands: [], tiers: [], aborted: 0, exited: 0 };
  const tui = new Tui(vt.asTty(), {
    onSubmit: (t) => cap.submitted.push(t),
    onCommand: (c) => cap.commands.push(c),
    onTierChange: (t) => cap.tiers.push(t.id),
    onAbort: async () => {
      cap.aborted += 1;
    },
    onExit: () => {
      cap.exited += 1;
    },
    onSetKey: () => {},
    onRemoveKey: () => {},
    onTestProvider: () => {},
    onBindModel: () => {},
    onWizardKey: () => {},
    onBrandName: () => {},
    onBrandColors: () => {},
    onBrandReset: () => {},
    onAddProvider: () => {},
  });
  return { vt, tui, cap };
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5));

function type(tui: Tui, s: string): void {
  for (const ch of s) tui.handleKey({ kind: "char", ch });
}

function key(tui: Tui, kind: "enter" | "escape" | "up" | "down" | "left" | "right" | "tab" | "ctrl-c" | "ctrl-p"): void {
  tui.handleKey({ kind });
}

function expectClean(vt: VirtualTerminal, cols: number): void {
  const screen = vt.screen();
  expect(vt.count("▌")).toBeLessThanOrEqual(1);
  expect(vt.count("╭")).toBeLessThanOrEqual(2);
  expect(vt.count("╰")).toBeLessThanOrEqual(2);
  expect(vt.count("│")).toBeLessThanOrEqual(72);
  if (cols < 56) expect(screen).not.toContain("███╗");
  expect(vt.count("enter send")).toBeLessThanOrEqual(1);
}

describe("virtual terminal resize storm", () => {
  it("survives rapid width dragging with zero residue", async () => {
    const { vt, tui } = makeVt(24, 0);
    tui.show();
    for (let round = 0; round < 3; round++) {
      for (const cols of [90, 40, 18, 60, 24, 90, 30, 25, 12, 90]) {
        vt.resize(cols, 24);
        await tui.onResizeAsync();
        expectClean(vt, cols);
      }
    }
  });

  it("survives resizes with typing, menus and picker open", async () => {
    const { vt, tui } = makeVt(40, 80);
    tui.show();
    type(tui, "fix the flaky test");
    vt.resize(40, 24);
    await tui.onResizeAsync();
    expectClean(vt, 40);
    key(tui, "enter");
    tui.endBusy();
    vt.resize(90, 24);
    await tui.onResizeAsync();
    console.log("DUMP:\n" + vt.screen());
    expect(vt.count("╭")).toBe(1);
    type(tui, "/");
    vt.resize(30, 24);
    await tui.onResizeAsync();
    expect(vt.count("/model")).toBeLessThanOrEqual(1);
    expect(vt.count("╭")).toBe(1);
    key(tui, "escape");
    tui.openPicker();
    vt.resize(70, 24);
    await tui.onResizeAsync();
    expect(vt.count("select model")).toBe(1);
    key(tui, "down");
    vt.resize(26, 24);
    await tui.onResizeAsync();
    key(tui, "enter");
    expect(vt.screen()).toContain("set to MIMON");
    for (const line of vt.screen().split("\n")) {
      expect(line.length).toBeLessThanOrEqual(70);
    }
  });

  it("survives resizes at tiny pane heights without stacking", async () => {
    const { vt, tui } = makeVt(24, 80);
    tui.show();
    for (const [cols, rows] of [[80, 8], [80, 6], [80, 4], [80, 24], [40, 5], [40, 24]] as Array<[number, number]>) {
      vt.resize(cols, rows);
      await tui.onResizeAsync();
      expect(vt.count("Ask anything")).toBe(1);
      expect(vt.count("●")).toBeLessThanOrEqual(3);
    }
  });

  it("survives notices and tier cycles during a drag", async () => {
    const { vt, tui } = makeVt(24, 80);
    tui.show();
    for (const cols of [80, 45, 80, 28, 80]) {
      vt.resize(cols, 24);
      await tui.onResizeAsync();
      key(tui, "tab");
      expectClean(vt, cols);
    }
    expect(tui.tier.id).toBe("mimon3");
  });

  it("keeps the screen clean through a full session lifecycle", async () => {
    const { vt, tui, cap } = makeVt(24, 80);
    tui.show();
    type(tui, "task one");
    key(tui, "enter");
    expect(cap.submitted).toEqual(["task one"]);
    tui.endBusy();
    for (const cols of [90, 40, 90]) {
      vt.resize(cols, 24);
      await tui.onResizeAsync();
      expect(vt.count("Ask anything")).toBe(1);
    }
    type(tui, "task two");
    key(tui, "enter");
    tui.endBusy();
    key(tui, "up");
    key(tui, "enter");
    expect(cap.submitted).toEqual(["task one", "task two", "task two"]);
    key(tui, "ctrl-c");
    expect(cap.exited).toBe(1);
  });
});

describe("brand picker under hero", () => {
  it("repaints fully with no residue and keeps the palette inside the box on wide screens", () => {
    const { vt, tui } = makeVt(30, 200);
    tui.enableHero("0.1.0");
    tui.show();
    tui.openBrand({ name: "BLO", colors: ["teal", "gold"] });
    expect(vt.count("make it yours")).toBe(1);
    key(tui, "down");
    key(tui, "enter");
    expect(vt.count("one color for the whole name")).toBe(1);
    key(tui, "down");
    key(tui, "enter");
    expect(vt.count("brand colors")).toBe(1);
    expect(vt.count("BLO")).toBeLessThanOrEqual(2);
    key(tui, "down");
    key(tui, "enter");
    expect(vt.count("letter L (2/3)")).toBe(1);
    expect(vt.count("╭")).toBeLessThanOrEqual(3);
    key(tui, "enter");
    expect(vt.count("letter O (3/3)")).toBe(1);
    key(tui, "enter");
    key(tui, "down");
    expect(vt.count("brand colors")).toBe(0);
    expect(vt.count("make it yours")).toBe(0);
    expect(vt.count("╭")).toBeLessThanOrEqual(2);
    expectClean(vt, 200);
    for (const line of vt.screen().split("\n")) {
      expect(line.length).toBeLessThanOrEqual(200);
    }
  });

  it("navigating the palette does not flash: full clears only on entry and height changes", async () => {
    const { vt, tui } = makeVt(30, 200);
    tui.enableHero("0.1.0");
    tui.show();
    const before = vt.fullClears;
    tui.openBrand({ name: "BLO", colors: ["teal", "gold"] });
    const afterOpen = vt.fullClears;
    key(tui, "down");
    key(tui, "enter");
    const afterPicker = vt.fullClears;
    expect(afterOpen).toBe(before);
    expect(afterPicker).toBe(before);
    for (let i = 0; i < 6; i++) {
      key(tui, "down");
      key(tui, "right");
    }
    expect(vt.fullClears).toBe(afterPicker);
    expect(vt.count("brand colors")).toBe(1);
    expect(vt.count("╭")).toBeLessThanOrEqual(3);
    expect(vt.count("▌")).toBeLessThanOrEqual(1);
    for (const line of vt.screen().split("\n")) {
      expect(line.length).toBeLessThanOrEqual(200);
    }
  });
});

describe("resize never overflows the screen", () => {
  it("box always fits the viewport at every size in a live drag sweep", async () => {
    const { vt, tui } = makeVt(40, 120);
    tui.enableHero("0.1.4");
    tui.show();
    const sizes: Array<[number, number]> = [
      [120, 40], [90, 30], [70, 24], [60, 20], [52, 16], [50, 14],
      [50, 12], [60, 20], [50, 12], [120, 40], [80, 18], [50, 12], [120, 40],
    ];
    for (const [cols, rows] of sizes) {
      vt.resize(cols, rows);
      await tui.onResizeAsync();
      const screen = vt.screen();
      const lines = screen.split("\n");
      for (const line of lines) {
        expect(line.length).toBeLessThanOrEqual(cols);
      }
      expect((screen.match(/╭/g) ?? []).length).toBe(1);
      expect(screen).toContain("Ask anything");
    }
  });

  it("banner degrades instead of overflowing: art on tall, one-line on medium, gone on tiny", async () => {
    const { vt, tui } = makeVt(30, 120);
    tui.enableHero("0.1.4");
    tui.show();
    vt.resize(120, 30);
    await tui.onResizeAsync();
    expect(vt.screen()).toContain("██");
    vt.resize(120, 18);
    await tui.onResizeAsync();
    const medium = vt.screen();
    expect(medium).toContain("✦");
    expect(medium).not.toContain("██");
    vt.resize(120, 12);
    await tui.onResizeAsync();
    const tiny = vt.screen();
    expect(tiny).not.toContain("██");
    expect(tiny).toContain("Ask anything");
  });
});

describe("compact bottom-anchored box", () => {
  it("box hugs its content, floats mid-screen with the void split around it, footer pinned", () => {
    const { vt, tui } = makeVt(30, 100);
    tui.enableHero("0.1.4");
    tui.show();
    const lines = vt.screen().split("\n");
    const topIdx = lines.findIndex((l) => l.includes("╭"));
    const bottomIdx = lines.findIndex((l) => l.includes("╰"));
    expect(topIdx).toBeGreaterThan(0);
    expect(lines[0]!.trim()).toBe("");
    expect(bottomIdx).toBeGreaterThan(topIdx);
    expect(bottomIdx).toBeLessThan(28);
    expect(lines[28] ?? "").toContain("enter send");
    expect(lines[29] ?? "").toContain("tip");
    expect(vt.count("╭")).toBe(1);
  });

  it("keeps the brand name readable when the width cannot fit the block art — borderless minimal", () => {
    const mini = glyphWord(brandName(), true);
    const cols = mini!.width + 8;
    const { vt, tui } = makeVt(30, cols);
    tui.enableHero("0.1.4");
    tui.show();
    const screen = vt.screen();
    expect(screen).toContain("✦ " + brandName());
    expect(vt.count("╭")).toBe(1);
    for (const line of screen.split("\n")) {
      expect(line.length).toBeLessThanOrEqual(cols);
    }
  });

  it("at ultra-narrow width there is no broken border — a complete minimal prompt", () => {
    const { vt, tui } = makeVt(30, 12);
    tui.enableHero("0.1.4");
    tui.show();
    const screen = vt.screen();
    expect(screen).not.toContain("╭");
    expect(screen).not.toContain("╰");
    expect(screen).not.toContain("├");
    expect(screen).toContain("Ask");
    for (const line of screen.split("\n")) {
      expect(line.length).toBeLessThanOrEqual(12);
    }
  });

  it("hero art is centered inside the box, not glued to the left edge", () => {
    const { vt, tui } = makeVt(30, 100);
    tui.enableHero("0.1.4");
    tui.show();
    const artLine = vt.screen().split("\n").find((l) => l.includes("█"));
    expect(artLine).toBeDefined();
    const indent = artLine!.indexOf("█");
    expect(indent).toBeGreaterThan(10);
  });

  it("box grows upward as chat fills and caps at the viewport without overflow", () => {
    const { vt, tui } = makeVt(30, 100);
    tui.show();
    for (let i = 0; i < 80; i++) tui.historyPush("chat line " + i);
    tui.refresh();
    const lines = vt.screen().split("\n");
    const topIdx = lines.findIndex((l) => l.includes("╭"));
    expect(topIdx).toBe(0);
    expect(lines.length).toBeLessThanOrEqual(30);
    expect((vt.screen().match(/╭/g) ?? []).length).toBe(1);
    expect(vt.screen()).toContain("Ask anything");
  });
});

describe("resize coalescing", () => {
  it("a burst of resize signals in one tick produces a single repaint", async () => {
    const { vt, tui } = makeVt(40, 120);
    tui.enableHero("0.1.4");
    tui.show();
    vt.fullClears = 0;
    for (let i = 0; i < 8; i++) tui.onResize();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(vt.fullClears).toBe(1);
    expect((vt.screen().match(/╭/g) ?? []).length).toBe(1);
  });
});

describe("cursor drift on resize", () => {
  it("a plain refresh after width change repaints from home — one box, no stacking", async () => {
    const { vt, tui } = makeVt(40, 120);
    tui.enableHero("0.1.4");
    tui.show();
    vt.resize(80, 24);
    vt.row = 20;
    vt.col = 30;
    tui.refresh();
    const screen = vt.screen();
    expect((screen.match(/╭/g) ?? []).length).toBe(1);
    expect(screen).toContain("Ask anything");
    for (const line of screen.split("\n")) {
      expect(line.length).toBeLessThanOrEqual(80);
    }
  });
});

describe("centered single box", () => {
  it("box is centered at wide sizes and appears exactly once through a drag sweep", async () => {
    const { vt, tui } = makeVt(40, 120);
    tui.enableHero("0.1.4");
    tui.show();
    for (const [cols, rows] of [[120, 40], [90, 30], [70, 24], [55, 16], [120, 40], [60, 20]] as Array<[number, number]>) {
      vt.resize(cols, rows);
      await tui.onResizeAsync();
      const lines = vt.screen().split("\n");
      const topIdx = lines.findIndex((l) => l.includes("╭"));
      expect(topIdx).toBeGreaterThanOrEqual(0);
      const lead = lines[topIdx]!.indexOf("╭");
      if (cols >= 100) expect(lead).toBeGreaterThan(5);
      expect((vt.screen().match(/╭/g) ?? []).length).toBe(1);
      expect(vt.screen()).toContain("Ask anything");
      for (const line of lines) {
        expect(line.length).toBeLessThanOrEqual(cols);
      }
    }
  });
});

describe("real cursor placement", () => {
  it("sits at the text end inside the input box", () => {
    const { vt, tui } = makeVt(40, 100);
    tui.show();
    tui.openBrand({ name: "MEMO", colors: ["teal", "gold"] });
    key(tui, "escape");
    for (const ch of "fdfdf") tui.handleKey({ kind: "char", ch });
    const lines = vt.screen().split("\n");
    const inputLine = lines.findIndex((l) => l.includes("fdfdf"));
    console.log("CDUMP row=" + vt.row + " col=" + vt.col + " inputLine=" + inputLine + "\n" + lines.map((l, i) => i + "| " + l).join("\n"));
    expect(inputLine).toBeGreaterThanOrEqual(0);
    expect(vt.row).toBe(inputLine);
    const textEnd = lines[inputLine]!.indexOf("fdfdf") + "fdfdf".length;
    expect(vt.col).toBe(textEnd);
  });

  it("stays on the input row while typing more", () => {
    const { vt, tui } = makeVt(40, 100);
    tui.show();
    for (const ch of "hello") tui.handleKey({ kind: "char", ch });
    expect(vt.row).toBe(vt.screen().split("\n").findIndex((l) => l.includes("hello")));
  });
});

describe("long chat never scrolls the screen", () => {
  it("200 chat lines at 24 rows stay clipped to one viewport with the newest visible", () => {
    const { vt, tui } = makeVt(24, 80);
    tui.show();
    for (let i = 0; i < 200; i++) tui.historyPush("chat line " + i + " padding text so some lines wrap around");
    tui.refresh();
    const screen = vt.screen();
    expect(vt.screen().split("\n").length).toBeLessThanOrEqual(24);
    expect((screen.match(/╭/g) ?? []).length).toBe(1);
    expect(screen).toContain("chat line 199");
    expect(screen).toContain("Ask anything");
  });

  it("streaming into a full history keeps one box and the newest text on screen", () => {
    const { vt, tui } = makeVt(24, 80);
    tui.show();
    for (let i = 0; i < 200; i++) tui.historyPush("old line " + i);
    type(tui, "task");
    key(tui, "enter");
    tui.historyStream("fresh answer tokens");
    const screen = vt.screen();
    expect((screen.match(/╭/g) ?? []).length).toBe(1);
    expect(screen).toContain("fresh answer tokens");
    expect(vt.screen().split("\n").length).toBeLessThanOrEqual(24);
  });
});

describe("resize during a running turn", () => {
  it("repaints exactly one box while busy instead of freezing the old frame", async () => {
    const { vt, tui } = makeVt(24, 80);
    tui.show();
    type(tui, "long task");
    key(tui, "enter");
    vt.resize(120, 40);
    await tui.onResizeAsync();
    const screen = vt.screen();
    expect((screen.match(/╭/g) ?? []).length).toBe(1);
    expect(screen).toContain("working");
    for (const line of screen.split("\n")) {
      expect(line.length).toBeLessThanOrEqual(120);
    }
  });
});

describe("displaced cursor after terminal reflow", () => {
  it("keeps one box when the terminal leaves the cursor anywhere mid-screen", () => {
    const { vt, tui } = makeVt(24, 120);
    tui.show();
    vt.resize(60, 20);
    vt.row = 7;
    vt.col = 43;
    type(tui, "abc");
    const screen = vt.screen();
    expect((screen.match(/╭/g) ?? []).length).toBe(1);
    expect(screen).toContain("abc");
    expect(vt.screen().split("\n").length).toBeLessThanOrEqual(20);
  });
});

describe("stale frames coming back from scrollback", () => {
  it("a resize wipes old-frame rows the terminal pulls back into view", async () => {
    const { vt, tui } = makeVt(24, 80);
    tui.show();
    vt.resize(90, 30);
    const grid = (vt as unknown as { grid: string[][] }).grid;
    grid[0] = "╭─ old frame from scrollback".padEnd(90).split("");
    grid[5] = "╰─ old frame bottom".padEnd(90).split("");
    await tui.onResizeAsync();
    const screen = vt.screen();
    expect((screen.match(/╭/g) ?? []).length).toBe(1);
    expect(screen).not.toContain("old frame");
    expect(screen).toContain("Ask anything");
    for (const line of screen.split("\n")) {
      expect(line.length).toBeLessThanOrEqual(90);
    }
  });
});

describe("form bounds", () => {
  it("a long base URL stays inside the box on the rendered screen", () => {
    const { vt, tui } = makeVt(24, 80);
    tui.openProviders([{ name: "anthropic", models: ["m"], keySet: false }]);
    tui.show();
    key(tui, "down");
    key(tui, "enter");
    for (const ch of "myprovider") tui.handleKey({ kind: "char", ch });
    key(tui, "enter");
    for (const ch of "https://api.very-long-domain-name.example.com/openai/v1/with/long/path/segments") tui.handleKey({ kind: "char", ch });
    const screen = vt.screen();
    for (const line of screen.split("\n")) {
      expect(line.length).toBeLessThanOrEqual(80);
    }
    expect(screen).toContain("…");
    expect(screen).not.toContain("very-long-domain");
  });
});

describe("full chat flow in box", () => {
  it("renders YOU, streamed answer, tool line and error inside the box", async () => {
    const { vt, tui } = makeVt(40, 100);
    tui.show();
    const chat = new Chat({ write: () => {}, columns: 100, rows: 40 }, async () => "n");
    chat.uiHandlesErrors = true;
    chat.onError = (m) => tui.showError(m);
    chat.ui = {
      printAbove: (ls) => {
        for (const line of ls) tui.historyPush(line);
      },
      stream: (t) => tui.historyStream(t),
      streamStart: () => {},
      streamEnd: () => tui.historyStreamEnd(),
      replaceLast: (l) => tui.historyReplaceLast(l),
      setStatus: () => {},
    };
    const type = (s: string) => { for (const ch of s) tui.handleKey({ kind: "char", ch }); };
    type("hi");
    key(tui, "enter");
    tui.beginBusy();
    chat.ui?.printAbove(["\x1b[7m YOU \x1b[0m hi"]);
    await chat.onEvent({ type: "token.delta", payload: { text: "Salam! Kifach " } });
    await chat.onEvent({ type: "token.delta", payload: { text: "n3awnek?" } });
    await chat.onEvent({ type: "message.completed", payload: {} });
    await chat.onEvent({ type: "tool.requested", payload: { name: "fs.read", arguments: { path: "a.ts" } } });
    await chat.onEvent({ type: "tool.result", payload: { ok: true, name: "fs.read" } });
    chat.ui?.printAbove(["\x1b[7m YOU \x1b[0m ok"]);
    await chat.onEvent({ type: "turn.failed", payload: { reason: "no API key" } });
    const rows = vt.screen().split("\n");
    const top = rows.findIndex((r) => r.includes("╭"));
    const bottoms = rows.map((r, i) => [r, i] as const).filter(([r]) => r.includes("╰"));
    expect(top).toBeGreaterThanOrEqual(0);
    expect(bottoms.length).toBeGreaterThan(0);
    const inside = rows.slice(top + 1, bottoms[bottoms.length - 1]![1]).join("\n");
    expect(inside).toContain("YOU");
    expect(inside).toContain("Salam! Kifach n3awnek?");
    expect(inside).toContain("fs.read");
    expect(inside).toContain("failed: no API key");
    const outside = rows.slice(0, top).join("\n");
    expect(outside).not.toContain("YOU");
    expect(outside).not.toContain("Salam");
    for (const line of rows) {
      expect(line.length).toBeLessThanOrEqual(100);
    }
    expect(vt.count("╭")).toBe(1);
  });
});

describe("double-send repro", () => {
  it("two failed sends: one box, each error exactly once, no stacked duplicates", async () => {
    const { vt, tui } = makeVt(40, 100);
    const chat = new Chat({ write: () => {}, columns: 100, rows: 40 }, async () => "n");
    chat.uiHandlesErrors = true;
    chat.onError = (m) => tui.showError(m);
    chat.ui = {
      printAbove: (ls) => {
        for (const line of ls) tui.historyPush(line);
      },
      stream: (t) => tui.historyStream(t),
      streamStart: () => {},
      streamEnd: () => tui.historyStreamEnd(),
      replaceLast: (l) => tui.historyReplaceLast(l),
      setStatus: () => {},
    };
    tui.show();
    const type = (s: string) => { for (const ch of s) tui.handleKey({ kind: "char", ch }); };
    const ui = chat.ui;
    const send = async (msg: string) => {
      type(msg);
      key(tui, "enter");
      tui.beginBusy();
      chat.ui?.printAbove([" YOU " + msg]);
      (chat as unknown as { awaitingRun: boolean }).awaitingRun = true;
      await chat.onEvent({ type: "turn.failed", payload: { reason: "no API key for gemini" } });
      (chat as unknown as { awaitingRun: boolean }).awaitingRun = false;
      chat.onError("failed: no API key for gemini");
      tui.endBusy();
    };
    await send("hi");
    await send("slm");
    const screen = vt.screen();
    expect((screen.match(/╭/g) ?? []).length).toBe(1);
    expect((screen.split("no API key").length - 1)).toBe(2);
    expect((screen.split(" YOU hi").length - 1)).toBe(1);
    expect((screen.split(" YOU slm").length - 1)).toBe(1);
    expect((screen.split("failed: no API key").length - 1)).toBe(2);
  });
});

describe("in-box errors", () => {
  it("renders the error inside the box, wrapped, and clears on send", () => {
    const { vt, tui } = makeVt(24, 80);
    tui.show();
    tui.showError('no API key for "gemini" — /providers → set key, or set AGENT_KEY_GEMINI');
    tui.setChatStatus("IDLE", 0);
    const errorScreen = vt.screen();
    expect(errorScreen).toContain("no API key");
    expect(errorScreen).toContain("MIMON 2");
    tui.setChatStatus("RESPONDING", 2);
    expect(vt.screen()).toContain("RESPONDING · steps 2");
    for (const line of errorScreen.split("\n")) {
      expect(line.length).toBeLessThanOrEqual(80);
    }
    for (const ch of "hi") tui.handleKey({ kind: "char", ch });
    key(tui, "enter");
    tui.endBusy();
    const screen = vt.screen();
    expect(screen.split("AGENT_KEY_GEMINI").length - 1).toBe(1);
    expect(screen).toContain("MIMON 2 · RESPONDING · steps 2");
  });
});
