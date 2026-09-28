import { describe, expect, it } from "bun:test";
import {
  decodeChunk,
  splash,
  TIERS,
  Tui,
  visibleLen,
  type Key,
  type MimonTier,
  type Tty,
} from "../src/tui/tui";

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;

class MockTty implements Tty {
  chunks: string[] = [];
  columns = 100;
  rows = 30;
  write(data: string): void {
    this.chunks.push(data);
  }
  clear(): void {
    this.chunks = [];
  }
  text(): string {
    return this.chunks.join("").replace(ANSI, "").replace(/\r/g, "\n");
  }
  lines(): string[] {
    return this.text().split("\n").filter((l) => l.length > 0);
  }
}

interface Captured {
  submitted: string[];
  commands: string[];
  tiers: MimonTier[];
  aborted: number;
  exited: number;
  keys: Array<{ name: string; key: string }>;
  removes: string[];
  tests: Array<{ name: string; model: string }>;
  binds: Array<{ role: string; binding: string }>;
  wizardKeys: Array<{ name: string; key: string }>;
  wizardSkips: number;
  brandNames: string[];
  brandColors: Array<[string, string]>;
  brandResets: number;
}

function makeTui(columns = 100, rows = 30): { tui: Tui; tty: MockTty; cap: Captured } {
  const tty = new MockTty();
  tty.columns = columns;
  tty.rows = rows;
  const cap: Captured = {
    submitted: [],
    commands: [],
    tiers: [],
    aborted: 0,
    exited: 0,
    keys: [],
    removes: [],
    tests: [],
    binds: [],
    wizardKeys: [],
    wizardSkips: 0,
    brandNames: [],
    brandColors: [],
    brandResets: 0,
  };
  const tui = new Tui(tty, {
    onSubmit: (t) => cap.submitted.push(t),
    onCommand: (c) => cap.commands.push(c),
    onTierChange: (t) => cap.tiers.push(t),
    onAbort: () => {
      cap.aborted += 1;
    },
    onExit: () => {
      cap.exited += 1;
    },
    onSetKey: (name, key) => cap.keys.push({ name, key }),
    onRemoveKey: (name) => cap.removes.push(name),
    onTestProvider: (name, model) => cap.tests.push({ name, model }),
    onBindModel: (role, binding) => cap.binds.push({ role, binding }),
    onWizardKey: (name, key) => cap.wizardKeys.push({ name, key }),
    onWizardSkip: () => {
      cap.wizardSkips += 1;
    },
      onBrandName: (name) => cap.brandNames.push(name),
      onBrandColors: (a, b) => cap.brandColors.push([a, b]),
      onBrandReset: () => {
        cap.brandResets += 1;
      },
  });
  return { tui, tty, cap };
}

function type(tui: Tui, s: string): void {
  for (const ch of s) tui.handleKey({ kind: "char", ch });
}

describe("splash", () => {
  it("renders the boxed MIMON art on wide terminals", () => {
    const tty = new MockTty();
    tty.columns = 100;
    splash(tty, "0.2.0");
    const t = tty.text();
    expect(t).toContain("╭");
    expect(t).toContain("██ ██ ██");
    expect(t).toContain("v0.2.0 · fully local");
  });

  it("renders the boxed thick letters on narrow terminals", () => {
    const tty = new MockTty();
    tty.columns = 40;
    splash(tty, "0.2.0");
    const t = tty.text();
    expect(t).toContain("█ █ █");
    expect(t).toContain("v0.2.0");
    expect(t).not.toContain("███╗");
  });

  it("falls back to a single plain line when the box cannot fit", () => {
    for (const columns of [12, 18, 23]) {
      const tty = new MockTty();
      tty.columns = columns;
      splash(tty, "0.2.0");
      const t = tty.text();
      expect(t).toContain("✦ MIMON");
      expect(t).not.toContain("╭");
      for (const line of tty.lines()) {
        expect(visibleLen(line)).toBeLessThanOrEqual(columns);
      }
    }
  });

  it("keeps the box inside the terminal width", () => {
    for (const columns of [40, 48, 60, 100]) {
      const tty = new MockTty();
      tty.columns = columns;
      splash(tty, "0.2.0");
      for (const line of tty.lines()) {
        expect(visibleLen(line)).toBeLessThanOrEqual(columns - 1);
      }
    }
  });

  it("falls back to the compact box when the width is unknown", () => {
    const tty = new MockTty();
    tty.columns = 0;
    splash(tty, "0.2.0");
    const t = tty.text();
    expect(t).toContain("█ █ █");
    expect(t).not.toContain("███╗");
    for (const line of tty.lines()) {
      expect(visibleLen(line)).toBeLessThanOrEqual(40);
    }
  });

  it("grows the hero box live when the terminal is enlarged", () => {
    const { tui, tty } = makeTui(40, 24);
    tui.enableHero("0.2.0");
    tui.show();
    expect(tty.text()).toContain("█ █ █");
    tty.clear();
    tty.columns = 90;
    tui.onResize();
    const t = tty.text();
    expect(t).toContain("██ ██ ██");
    expect(t).toContain("v0.2.0 · fully local");
    expect(t).toContain("Ask anything");
    expect(t.split("╭").length - 1).toBe(2);
    for (const line of tty.lines()) {
      expect(visibleLen(line)).toBeLessThanOrEqual(89);
    }
  });

  it("never duplicates the box across resize sweeps", () => {
    const { tui, tty } = makeTui(24, 24);
    tui.enableHero("0.2.0");
    tui.show();
    for (const cols of [18, 30, 60, 90, 30, 90, 24]) {
      tty.clear();
      tty.columns = cols;
      tui.onResize();
      expect(tty.text().split("╭").length - 1).toBe(cols >= 32 ? 2 : 1);
      for (const line of tty.lines()) {
        expect(visibleLen(line)).toBeLessThanOrEqual(Math.max(20, cols));
      }
    }
  });

  it("repaints the whole pane on resize while the hero is up, leaving no residue", () => {
    const { tui, tty } = makeTui(90, 24);
    tui.enableHero("0.2.0");
    tui.show();
    tty.clear();
    tty.columns = 40;
    tui.onResize();
    expect(tty.chunks.join("")).toContain("\x1b[2J");
    const t = tty.text();
    expect(t).not.toContain("███╗");
    expect(t.split("╭").length - 1).toBe(2);
    expect(t).toContain("█ █ █");
  });

  it("drops the hero box after the first submission", () => {
    const { tui, tty } = makeTui(80, 24);
    tui.enableHero("0.2.0");
    tui.show();
    type(tui, "task");
    tty.clear();
    tui.handleKey({ kind: "enter" });
    tui.endBusy();
    expect(tty.text()).not.toContain("███╗");
    expect(tty.text()).toContain("Ask anything");
  });
});

describe("prompt chrome", () => {
  it("shows placeholder, tier status, hints and tip", () => {
    const { tui, tty } = makeTui();
    tui.show();
    const t = tty.text();
    expect(t).toContain("Ask anything");
    expect(t).toContain("MIMON 2");
    expect(t).toContain("enter send");
    expect(t).toContain("tip");
  });

  it("keeps every rendered line inside the terminal width", () => {
    for (const columns of [40, 52, 64, 100, 140]) {
      const { tui, tty } = makeTui(columns, 24);
      tui.show();
      type(tui, "/mod");
      type(tui, "hello world this is a long typed line for wrapping checks");
      for (const line of tty.lines()) {
        expect(visibleLen(line)).toBeLessThanOrEqual(columns - 1);
      }
    }
  });
});

describe("slash menu", () => {
  it("filters commands as the user types", () => {
    const { tui, tty } = makeTui();
    tui.show();
    type(tui, "/");
    tty.clear();
    type(tui, "mo");
    const t = tty.text();
    expect(t).toContain("/model");
    expect(t).not.toContain("/new");
  });

  it("executes the highlighted command on enter", () => {
    const { tui, cap } = makeTui();
    tui.show();
    type(tui, "/");
    tui.handleKey({ kind: "down" });
    tui.handleKey({ kind: "enter" });
    expect(cap.commands).toEqual(["/model"]);
  });
});

describe("model picker", () => {
  it("lists all four MIMON tiers", () => {
    const { tui, tty } = makeTui();
    tui.show();
    tui.openPicker();
    const t = tty.text();
    expect(t).toContain("select model");
    expect(t).toContain("MIMON 1");
    expect(t).toContain("MIMON 2");
    expect(t).toContain("MIMON 3");
    expect(t).toContain("MIMON MAX");
  });

  it("selects MIMON MAX with arrows and enter", () => {
    const { tui, tty, cap } = makeTui();
    tui.show();
    tui.openPicker();
    tui.handleKey({ kind: "down" });
    tui.handleKey({ kind: "down" });
    tui.handleKey({ kind: "enter" });
    expect(cap.tiers.map((t) => t.id)).toEqual(["mimonMax"]);
    expect(tui.tier.id).toBe("mimonMax");
    expect(tty.text()).toContain("✓ model set to MIMON MAX");
  });

  it("closes on escape without changing the tier", () => {
    const { tui, tty, cap } = makeTui();
    tui.show();
    tui.openPicker();
    tty.clear();
    tui.handleKey({ kind: "escape" });
    expect(cap.tiers).toEqual([]);
    expect(tty.text()).not.toContain("select model");
  });
});

describe("editing and history", () => {
  it("submits typed text and hides chrome while busy", () => {
    const { tui, tty, cap } = makeTui();
    tui.show();
    type(tui, "fix the flaky test");
    tty.clear();
    tui.handleKey({ kind: "enter" });
    expect(cap.submitted).toEqual(["fix the flaky test"]);
    expect(tty.text()).not.toContain("Ask anything");
    tui.endBusy();
    expect(tty.text()).toContain("Ask anything");
  });

  it("recalls the previous submission with the up arrow", () => {
    const { tui, cap } = makeTui();
    tui.show();
    type(tui, "first task");
    tui.handleKey({ kind: "enter" });
    tui.endBusy();
    type(tui, "second task");
    tui.handleKey({ kind: "enter" });
    tui.endBusy();
    tui.handleKey({ kind: "up" });
    tui.handleKey({ kind: "enter" });
    expect(cap.submitted).toEqual(["first task", "second task", "second task"]);
  });

  it("backspace and cursor moves edit the line", () => {
    const { tui, cap } = makeTui();
    tui.show();
    type(tui, "abc");
    tui.handleKey({ kind: "left" });
    tui.handleKey({ kind: "backspace" });
    tui.handleKey({ kind: "enter" });
    expect(cap.submitted).toEqual(["ac"]);
  });

  it("tab cycles MIMON tiers", () => {
    const { tui, cap } = makeTui();
    tui.show();
    tui.handleKey({ kind: "tab" });
    expect(cap.tiers.map((t) => t.id)).toEqual(["mimon3"]);
    tui.handleKey({ kind: "tab" });
    expect(tui.tier.id).toBe("mimonMax");
  });
});

describe("busy and permission states", () => {
  it("escape aborts a running turn", () => {
    const { tui, cap } = makeTui();
    tui.show();
    type(tui, "long task");
    tui.handleKey({ kind: "enter" });
    tui.handleKey({ kind: "escape" });
    expect(cap.aborted).toBe(1);
  });

  it("answers a permission card with a single key", async () => {
    const { tui } = makeTui();
    const pending = tui.permission();
    tui.handleKey({ kind: "char", ch: "v" });
    expect(await pending).toBe("v");
  });

  it("escape on a permission card denies", async () => {
    const { tui } = makeTui();
    const pending = tui.permission();
    tui.handleKey({ kind: "escape" });
    expect(await pending).toBe("n");
  });

  it("ctrl+c exits from any state", () => {
    const { tui, cap } = makeTui();
    tui.handleKey({ kind: "ctrl-c" });
    expect(cap.exited).toBe(1);
  });
});

describe("key decoding", () => {
  it("decodes arrows, control keys and chars", () => {
    const { keys, rest } = decodeChunk("\x1b[A\x1b[B\rc\x7f\x1b");
    expect(keys).toEqual([
      { kind: "up" },
      { kind: "down" },
      { kind: "enter" },
      { kind: "char", ch: "c" },
      { kind: "backspace" },
    ]);
    expect(rest).toBe("\x1b");
  });

  it("holds a partial escape sequence for the next chunk", () => {
    const first = decodeChunk("hi\x1b[");
    expect(first.keys.map((k) => k.kind)).toEqual(["char", "char"]);
    expect(first.rest).toBe("\x1b[");
    const second = decodeChunk(first.rest + "D");
    expect(second.keys).toEqual([{ kind: "left" }]);
  });

  it("swallows unknown CSI sequences", () => {
    const { keys } = decodeChunk("\x1b[Z\x1b[15~a");
    expect(keys).toEqual([{ kind: "char", ch: "a" }]);
  });
});

describe("tiers data", () => {
  it("exposes the four MIMON tiers in order", () => {
    expect(TIERS.map((t) => t.label)).toEqual(["MIMON 1", "MIMON 2", "MIMON 3", "MIMON MAX"]);
    expect(TIERS.map((t) => t.id)).toEqual(["mimon1", "mimon2", "mimon3", "mimonMax"]);
  });
});

describe("providers views", () => {
  const PROVIDERS = [
    { name: "anthropic", models: ["claude-sonnet-4-5", "claude-haiku-4-5"], keySet: true },
    { name: "openai", models: ["gpt-5"], keySet: false },
  ];

  function openProviders(tui: Tui): void {
    tui.openProviders(PROVIDERS);
    tui.show();
  }

  it("lists providers with key status", () => {
    const { tui, tty } = makeTui(100, 30);
    openProviders(tui);
    const t = tty.text();
    expect(t).toContain("cloud providers");
    expect(t).toContain("anthropic");
    expect(t).toContain("key saved");
    expect(t).toContain("openai");
    expect(t).toContain("no key");
  });

  it("opens the provider detail and selects a model for binding", () => {
    const { tui, tty, cap } = makeTui(100, 30);
    openProviders(tui);
    tui.handleKey({ kind: "enter" });
    let t = tty.text();
    expect(t).toContain("claude-sonnet-4-5");
    expect(t).toContain("replace key");
    expect(t).toContain("test key");

    tui.handleKey({ kind: "enter" });
    t = tty.text();
    expect(t).toContain("bind claude-sonnet-4-5 to");
    tui.handleKey({ kind: "down" });
    tui.handleKey({ kind: "enter" });
    expect(cap.binds).toEqual([{ role: "mimon2", binding: "anthropic/claude-sonnet-4-5" }]);
  });

  it("masks the key input and submits the typed key", () => {
    const { tui, tty, cap } = makeTui(100, 30);
    openProviders(tui);
    tui.handleKey({ kind: "enter" });
    tui.handleKey({ kind: "down" });
    tui.handleKey({ kind: "down" });
    tui.handleKey({ kind: "enter" });
    type(tui, "sk-secret-123");
    const t = tty.text();
    expect(t).toContain("●●●●●●●●●●●●●");
    expect(t).not.toContain("sk-secret-123");
    tui.handleKey({ kind: "enter" });
    expect(cap.keys).toEqual([{ name: "anthropic", key: "sk-secret-123" }]);
  });

  it("escapes cancel the key input without submitting", () => {
    const { tui, cap } = makeTui(100, 30);
    openProviders(tui);
    tui.handleKey({ kind: "enter" });
    tui.handleKey({ kind: "down" });
    tui.handleKey({ kind: "down" });
    tui.handleKey({ kind: "enter" });
    type(tui, "sk-x");
    tui.handleKey({ kind: "escape" });
    expect(cap.keys).toEqual([]);
  });

  it("navigates a no-key provider with set key and test actions", () => {
    const { tui, tty, cap } = makeTui(100, 30);
    openProviders(tui);
    tui.handleKey({ kind: "down" });
    tui.handleKey({ kind: "enter" });
    const t = tty.text();
    expect(t).toContain("set key");
    expect(t).toContain("no key");
    expect(t).not.toContain("remove key");
    tui.handleKey({ kind: "down" });
    tui.handleKey({ kind: "down" });
    tui.handleKey({ kind: "enter" });
    expect(cap.tests).toEqual([{ name: "openai", model: "gpt-5" }]);
  });

  it("walks back out with escape", () => {
    const { tui, tty } = makeTui(100, 30);
    openProviders(tui);
    tui.handleKey({ kind: "enter" });
    tui.handleKey({ kind: "escape" });
    expect(tty.text()).toContain("cloud providers");
    tui.handleKey({ kind: "escape" });
    expect(tty.text()).toContain("Ask anything");
  });
});

describe("setup wizard", () => {
  const PROVIDERS = [
    { name: "anthropic", models: ["claude-sonnet-4-5"], keySet: false },
    { name: "openai", models: ["gpt-5"], keySet: false },
  ];

  it("shows the welcome header, providers and the skip row", () => {
    const { tui, tty } = makeTui(100, 30);
    tui.openWizard(PROVIDERS);
    tui.show();
    const t = tty.text();
    expect(t).toContain("welcome to mimon");
    expect(t).toContain("anthropic");
    expect(t).toContain("no key");
    expect(t).toContain("skip · use local Ollama");
  });

  it("takes a provider straight to the key prompt and fires onWizardKey", () => {
    const { tui, tty, cap } = makeTui(100, 30);
    tui.openWizard(PROVIDERS);
    tui.show();
    tui.handleKey({ kind: "enter" });
    expect(tty.text()).toContain("API key for anthropic");
    type(tui, "sk-abc");
    tui.handleKey({ kind: "enter" });
    expect(cap.wizardKeys).toEqual([{ name: "anthropic", key: "sk-abc" }]);
    expect(cap.keys).toEqual([]);
  });

  it("keeps the regular providers flow separate from the wizard hooks", () => {
    const { tui, cap } = makeTui(100, 30);
    tui.openProviders(PROVIDERS);
    tui.show();
    tui.handleKey({ kind: "enter" });
    tui.handleKey({ kind: "down" });
    tui.handleKey({ kind: "enter" });
    type(tui, "sk-secret");
    tui.handleKey({ kind: "enter" });
    expect(cap.keys).toEqual([{ name: "anthropic", key: "sk-secret" }]);
    expect(cap.wizardKeys).toEqual([]);
  });

  it("fires onWizardSkip from the skip row", () => {
    const { tui, cap } = makeTui(100, 30);
    tui.openWizard(PROVIDERS);
    tui.show();
    tui.handleKey({ kind: "down" });
    tui.handleKey({ kind: "down" });
    tui.handleKey({ kind: "enter" });
    expect(cap.wizardSkips).toBe(1);
  });

  it("escape closes the wizard without skipping", () => {
    const { tui, tty, cap } = makeTui(100, 30);
    tui.openWizard(PROVIDERS);
    tui.show();
    tui.handleKey({ kind: "escape" });
    expect(cap.wizardSkips).toBe(0);
    expect(tty.text()).toContain("Ask anything");
  });
});

describe("brand view", () => {
  it("is reachable from the slash menu", () => {
    const { tui, tty } = makeTui();
    tui.show();
    type(tui, "/");
    tty.clear();
    type(tui, "br");
    expect(tty.text()).toContain("/brand");
  });

  it("shows current identity and fires onBrandName with a valid name", () => {
    const { tui, tty, cap } = makeTui();
    tui.openBrand({ name: "ANIR", colors: ["purple", "pink"] });
    tui.show();
    const t = tty.text();
    expect(t).toContain("make it yours");
    expect(t).toContain("change name");
    expect(t).toContain("reset to defaults");

    tui.handleKey({ kind: "enter" });
    type(tui, "sam");
    tui.handleKey({ kind: "enter" });
    expect(cap.brandNames).toEqual(["SAM"]);
  });

  it("rejects an invalid name without firing the hook", () => {
    const { tui, tty, cap } = makeTui();
    tui.openBrand({ name: "ANIR", colors: ["purple", "pink"] });
    tui.show();
    tui.handleKey({ kind: "enter" });
    type(tui, "x");
    tui.handleKey({ kind: "enter" });
    expect(cap.brandNames).toEqual([]);
    expect(tty.text()).toContain("2-12 letters");
  });

  it("picks two colors and fires onBrandColors", () => {
    const { tui, tty, cap } = makeTui();
    tui.openBrand({ name: "ANIR", colors: ["purple", "pink"] });
    tui.show();
    tui.handleKey({ kind: "down" });
    tui.handleKey({ kind: "enter" });
    expect(tty.text()).toContain("pick color 1 of 2");
    tui.handleKey({ kind: "enter" });
    expect(tty.text()).toContain("pick color 2 of 2");
    tui.handleKey({ kind: "right" });
    tui.handleKey({ kind: "enter" });
    expect(cap.brandColors.length).toBe(1);
    expect(cap.brandColors[0]![0]).toBe("teal");
    expect(cap.brandColors[0]![1]).toBe("gold");
  });

  it("reset fires onBrandReset", () => {
    const { tui, cap } = makeTui();
    tui.openBrand({ name: "ANIR", colors: ["purple", "pink"] });
    tui.show();
    tui.handleKey({ kind: "down" });
    tui.handleKey({ kind: "down" });
    tui.handleKey({ kind: "enter" });
    expect(cap.brandResets).toBe(1);
  });
});
