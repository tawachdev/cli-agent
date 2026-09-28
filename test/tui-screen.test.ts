import { describe, expect, it } from "bun:test";
import { Tui, type Key, type Tty } from "../src/tui/tui";

class VirtualTerminal {
  cols: number;
  rows: number;
  private grid: string[][] = [];
  private row = 0;
  private col = 0;

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

  feed(data: string): void {
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
    onAbort: () => {
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
    onWizardSkip: () => {},
    onBrandName: () => {},
    onBrandColors: () => {},
    onBrandReset: () => {},
    onAddProvider: () => {},
  });
  return { vt, tui, cap };
}

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
  expect(vt.count("│")).toBeLessThanOrEqual(22);
  if (cols < 56) expect(screen).not.toContain("███╗");
  expect(vt.count("enter send")).toBeLessThanOrEqual(1);
}

describe("virtual terminal resize storm", () => {
  it("survives rapid width dragging with zero residue", () => {
    const { vt, tui } = makeVt(24, 0);
    tui.enableHero("0.2.0");
    tui.show();
    for (let round = 0; round < 3; round++) {
      for (const cols of [90, 40, 18, 60, 24, 90, 30, 25, 12, 90]) {
        vt.resize(cols, 24);
        tui.onResize();
        expectClean(vt, cols);
      }
    }
  });

  it("survives resizes with typing, menus and picker open", () => {
    const { vt, tui } = makeVt(24, 80);
    tui.enableHero("0.2.0");
    tui.show();
    type(tui, "fix the flaky test");
    vt.resize(40, 24);
    tui.onResize();
    expectClean(vt, 40);
    key(tui, "enter");
    tui.endBusy();
    vt.resize(90, 24);
    tui.onResize();
    expectClean(vt, 90);
    type(tui, "/");
    vt.resize(30, 24);
    tui.onResize();
    expect(vt.count("/model")).toBeLessThanOrEqual(1);
    expectClean(vt, 30);
    key(tui, "escape");
    tui.openPicker();
    vt.resize(70, 24);
    tui.onResize();
    expect(vt.count("select model")).toBe(1);
    expectClean(vt, 70);
    key(tui, "down");
    vt.resize(26, 24);
    tui.onResize();
    expectClean(vt, 26);
    key(tui, "enter");
    expectClean(vt, 26);
  });

  it("survives resizes at tiny pane heights without stacking", () => {
    const { vt, tui } = makeVt(24, 80);
    tui.enableHero("0.2.0");
    tui.show();
    for (const [cols, rows] of [[80, 8], [80, 6], [80, 4], [80, 24], [40, 5], [40, 24]] as Array<[number, number]>) {
      vt.resize(cols, rows);
      tui.onResize();
      expect(vt.count("Ask anything")).toBe(1);
      expect(vt.count("●")).toBeLessThanOrEqual(3);
    }
  });

  it("survives notices and tier cycles during a drag", () => {
    const { vt, tui } = makeVt(24, 80);
    tui.enableHero("0.2.0");
    tui.show();
    for (const cols of [80, 45, 80, 28, 80]) {
      vt.resize(cols, 24);
      tui.onResize();
      key(tui, "tab");
      expectClean(vt, cols);
    }
    expect(tui.tier.id).toBe("mimon3");
  });

  it("keeps the screen clean through a full session lifecycle", () => {
    const { vt, tui, cap } = makeVt(24, 80);
    tui.enableHero("0.2.0");
    tui.show();
    type(tui, "task one");
    key(tui, "enter");
    expect(cap.submitted).toEqual(["task one"]);
    tui.endBusy();
    for (const cols of [90, 40, 90]) {
      vt.resize(cols, 24);
      tui.onResize();
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
