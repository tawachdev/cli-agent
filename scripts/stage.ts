import { stdout } from "node:process";
import { C, PRODUCT_VERSION, Tui, type Tty } from "../src/tui/tui";

class Stage implements Tty {
  chunks: string[] = [];
  columns: number;
  rows = 24;
  constructor(columns: number) {
    this.columns = columns;
  }
  write(data: string): void {
    this.chunks.push(data);
  }
  frame(): string {
    const raw = this.chunks.join("");
    const start = raw.lastIndexOf("\x1b[J");
    const last = start >= 0 ? raw.slice(start + 3) : raw;
    return last
      .replace(/\x1b\[[0-9;?]*[ABCDHJK]/g, "")
      .replace(/\r/g, "");
  }
}

function type(tui: Tui, s: string): void {
  for (const ch of s) tui.handleKey({ kind: "char", ch });
}

function section(title: string, columns: number, drive: (tui: Tui) => void): void {
  const stage = new Stage(columns);
  const tui = new Tui(stage, {
    onSubmit: () => {},
    onCommand: () => {},
    onTierChange: () => {},
    onAbort: () => {},
    onExit: () => {},
    onSetKey: () => {},
    onRemoveKey: () => {},
    onTestProvider: () => {},
    onBindModel: () => {},
    onWizardKey: () => {},
    onWizardSkip: () => {},
    onBrandName: () => {},
    onBrandColors: () => {},
    onBrandReset: () => {},
  });
  tui.show();
  drive(tui);
  stdout.write(C.dim + "── " + title + " ──" + C.reset + "\n");
  stdout.write(stage.frame() + "\n\n");
}

const cols = stdout.columns > 30 ? stdout.columns : 80;
const narrow = Math.max(24, cols - 30);

section("idle", cols, () => {});
section("brand boot", cols, (tui) => {
  tui.enableHero(PRODUCT_VERSION);
  tui.onResize();
});
section("typed", cols, (tui) => type(tui, "fix the flaky test in auth"));
section("slash menu", cols, (tui) => {
  type(tui, "/mo");
});
section("model picker", cols, (tui) => {
  tui.openPicker();
  tui.handleKey({ kind: "down" });
  tui.handleKey({ kind: "down" });
});
section("permission", cols, (tui) => {
  void tui.permission();
});
section("setup wizard", cols, (tui) => {
  tui.openWizard([
    { name: "anthropic", models: ["claude-sonnet-4-5"], keySet: false },
    { name: "openai", models: ["gpt-5"], keySet: true },
  ]);
});
section("narrow idle", narrow, () => {});
