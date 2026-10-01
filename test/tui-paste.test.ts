import { describe, expect, it } from "bun:test";
import { decodeChunk, Tui, type Tty } from "../src/tui/tui";

class MockTty implements Tty {
  chunks: string[] = [];
  columns = 100;
  rows = 30;
  write(data: string): void {
    this.chunks.push(data);
  }
}

function makeTui(): { tui: Tui; tty: MockTty; submitted: string[] } {
  const tty = new MockTty();
  const submitted: string[] = [];
  const tui = new Tui(tty, {
    onSubmit: (t) => submitted.push(t),
    onCommand: () => {},
    onTierChange: () => {},
    onAbort: () => {},
    onExit: () => {},
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
  return { tui, tty, submitted };
}

function feed(tui: Tui, chunk: string): void {
  const { keys, rest } = decodeChunk(chunk);
  expect(rest).toBe("");
  for (const key of keys) tui.handleKey(key);
}

describe("bracketed paste", () => {
  it("multi-line paste never submits and newlines collapse to one space", () => {
    const { tui, tty, submitted } = makeTui();
    tui.show();
    feed(tui, "\x1b[200~line1\r\nline2\x1b[201~");
    expect(submitted).toEqual([]);
    tui.handleKey({ kind: "enter" });
    expect(submitted).toEqual(["line1 line2"]);
  });

  it("paste split across reads is held until the end marker arrives", () => {
    const { tui, submitted } = makeTui();
    tui.show();
    const first = decodeChunk("\x1b[200~line1\r");
    expect(first.rest).toBe("");
    for (const key of first.keys) tui.handleKey(key);
    const second = decodeChunk("\nline2\x1b[201~");
    expect(second.rest).toBe("");
    for (const key of second.keys) tui.handleKey(key);
    expect(submitted).toEqual([]);
    tui.handleKey({ kind: "enter" });
    expect(submitted).toEqual(["line1 line2"]);
  });

  it("lone carriage returns and lone line feeds each become one space", () => {
    const { tui, submitted } = makeTui();
    tui.show();
    feed(tui, "\x1b[200~a\rb\nc\x1b[201~");
    tui.handleKey({ kind: "enter" });
    expect(submitted).toEqual(["a b c"]);
  });

  it("keys after the paste end marker behave normally again", () => {
    const { tui, submitted } = makeTui();
    tui.show();
    feed(tui, "\x1b[200~paste\x1b[201~");
    for (const ch of " done") tui.handleKey({ kind: "char", ch });
    tui.handleKey({ kind: "enter" });
    expect(submitted).toEqual(["paste done"]);
  });
});
