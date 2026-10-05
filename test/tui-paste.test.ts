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

function makeTui(): { tui: Tui; tty: MockTty; submitted: string[]; wizardKeys: Array<{ name: string; key: string }>; wizardModels: Array<{ name: string; model: string }> } {
  const tty = new MockTty();
  const submitted: string[] = [];
  const wizardKeys: Array<{ name: string; key: string }> = [];
  const wizardModels: Array<{ name: string; model: string }> = [];
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
    onWizardKey: (name, key) => wizardKeys.push({ name, key }),
    onWizardModel: (name, model) => wizardModels.push({ name, model }),
    onTierModelPick: () => {},
    onBrandName: () => {},
    onBrandColors: () => {},
    onBrandReset: () => {},
    onAddProvider: () => {},
  });
  return { tui, tty, submitted, wizardKeys, wizardModels };
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

describe("paste lands in the focused field", () => {
  it("pasting an API key in the wizard key field fills the key, not the chat", () => {
    const { tui, submitted, wizardKeys } = makeTui();
    tui.show();
    tui.openWizard([{ name: "gemini", models: ["gemini-3-flash-preview"], keySet: false }]);
    tui.handleKey({ kind: "enter" });
    feed(tui, "\x1b[200~AQ.ab8-TEST-KEY-123\x1b[201~");
    tui.handleKey({ kind: "enter" });
    expect(wizardKeys).toEqual([{ name: "gemini", key: "AQ.ab8-TEST-KEY-123" }]);
    expect(submitted).toEqual([]);
  });

  it("returns to the chat prompt right after the wizard key entry", () => {
    const { tui, submitted, wizardKeys } = makeTui();
    tui.show();
    tui.openWizard([{ name: "glm", models: ["glm-4.6"], keySet: false }]);
    tui.handleKey({ kind: "enter" });
    for (const ch of "typed-key") tui.handleKey({ kind: "char", ch });
    tui.handleKey({ kind: "enter" });
    expect(wizardKeys).toEqual([{ name: "glm", key: "typed-key" }]);
    for (const ch of "now i type in chat") tui.handleKey({ kind: "char", ch });
    tui.handleKey({ kind: "enter" });
    expect(submitted).toEqual(["now i type in chat"]);
  });

  it("pasting a base url in the add-provider form fills the url field, not the chat", () => {
    const { tui, submitted } = makeTui();
    tui.show();
    tui.openWizard([]);
    feed(tui, "n");
    tui.handleKey({ kind: "enter" });
    feed(tui, "\x1b[200~https://api.example.com/v1\x1b[201~");
    tui.handleKey({ kind: "down" });
    tui.handleKey({ kind: "enter" });
    expect(submitted).toEqual([]);
  });
});

describe("model picker after wizard key", () => {
  it("binds the picked model to all tiers and returns to chat", () => {
    const { tui, wizardModels, submitted } = makeTui();
    tui.show();
    tui.openModelPick("gemini", ["gemini-3-flash-preview", "gemini-3.1-pro-preview", "gemini-flash-latest"]);
    tui.handleKey({ kind: "down" });
    tui.handleKey({ kind: "enter" });
    expect(wizardModels).toEqual([{ name: "gemini", model: "gemini-3.1-pro-preview" }]);
    expect(submitted).toEqual([]);
    for (const ch of "back in chat") tui.handleKey({ kind: "char", ch });
    tui.handleKey({ kind: "enter" });
    expect(submitted).toEqual(["back in chat"]);
  });

  it("keeps the current binding on escape", () => {
    const { tui, wizardModels } = makeTui();
    tui.show();
    tui.openModelPick("gemini", ["gemini-3-flash-preview", "gemini-3.1-pro-preview"]);
    tui.handleKey({ kind: "escape" });
    expect(wizardModels).toEqual([]);
    tui.handleKey({ kind: "enter" });
    tui.handleKey({ kind: "enter" });
    expect(wizardModels).toEqual([]);
  });
});
