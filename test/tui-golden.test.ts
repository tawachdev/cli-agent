// One long, scripted session through every TUI view and flow. The complete byte
// stream and every hook call are pinned, so a refactor that changes what the user
// sees — or what the app does — fails here. After an intended change, review the
// diff in the hook list, then refresh with: bun test test/tui-golden.test.ts -u
import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPng } from "./helpers/png";
import { decodeChunk, Tui } from "../src/tui/tui";

async function session(): Promise<{ output: string; hooks: string[] }> {
  const out: string[] = [];
  const log: string[] = [];
  const tty = { write: (d: string) => out.push(d), columns: 100, rows: 34 };
  const rec = (name: string) => (...a: unknown[]) => log.push(name + " " + JSON.stringify(a));
  const hooks = Object.fromEntries(["onSubmit","onCommand","onTierChange","onAbort","onExit","onSetKey","onRemoveKey","onTestProvider","onBindModel","onWizardKey","onWizardModel","onTierModelPick","onBrandName","onBrandColors","onBrandReset","onAddProvider"].map((n) => [n, rec(n)]));
  const tui = new Tui(tty, hooks, { imageSupport: "none", colorDepth: "256", openImage: rec("open") });
  const k = (s: string) => { if (s === ESC) return tui.handleKey({ kind: "escape" }); for (const key of decodeChunk(s).keys) tui.handleKey(key); };
  const ESC="\x1b";
  const UP="\x1b[A", DOWN="\x1b[B", LEFT="\x1b[D", RIGHT="\x1b[C", ENTER="\r", BS="\x7f";
  tui.enableHero("9.9.9");
  tui.show();
  k("hello"); k(BS); k("/"); k(DOWN); k(DOWN); k(ESC);
  tui.openPicker({ mimon1: "a/b" }); k(DOWN); k(UP); k(ENTER);
  tui.showHelp(["line one", "line two"]); k("x");
  const brand = { name: "MIMON", colors: ["teal", "gold"], customColors: ["#112233"] };
  tui.openBrand(brand); k(DOWN); k(UP); k(UP); k(DOWN); k(DOWN); k(ENTER); // reset
  tui.openBrand(brand); k(ENTER); k("A"); k(ENTER); k("bc"); k(BS); k("De"); k(ESC); k(ENTER); k("Nova"); k(ENTER);
  tui.openBrand(brand); k(DOWN); k(ENTER); k(DOWN); k(ENTER); // per letter
  k(RIGHT); k(DOWN); k(ENTER); k(LEFT); k(ENTER); k(ESC); k(ENTER);
  for (let i = 0; i < 40; i++) k(DOWN);
  k(ENTER); k("#12"); k(ENTER); k("3456"); k(ENTER);
  for (let i = 0; i < 40; i++) k(DOWN);
  k(DOWN); k(ENTER); k(RIGHT); k(DOWN); k(DOWN); k(LEFT); k(UP); k(ENTER); k(ENTER);
  tui.setBrandCustomColors(["#abcdef"]);
  tui.openBrand(brand); k(DOWN); k(ENTER); k(ENTER); k(ENTER); k(ESC); k(ESC); k(ESC);
  const providers = [{ name: "openai", models: ["gpt-5", "gpt-5-mini"], keySet: true }, { name: "gemini", models: ["g"], keySet: false }];
  tui.openProviders(providers); k(DOWN); k(UP); k(ENTER); k(DOWN); k(ENTER); k(DOWN); k(ENTER); // bind
  tui.openProviders(providers); k(ENTER); k(DOWN); k(DOWN); k(ENTER); k("sk-xyz"); k(BS); k(ENTER); k(DOWN); k(DOWN); k(DOWN); k(ENTER); k(DOWN); k(ENTER); k(ESC); k(ESC);
  tui.openProviders(providers); k(DOWN); k(DOWN); k(ENTER); k(ENTER); k("Bad"); k(ENTER); k(BS); k(BS); k(BS); k("my-llm"); k(ENTER); k("ftp://x"); k(ENTER);
  for (let i = 0; i < 7; i++) k(BS);
  k("https://llm.example/v1"); k(ENTER); k(UP); k(DOWN); k("m1, m2"); k(ENTER); k(ESC);
  tui.updateProviders(providers);
  tui.openWizard(providers); k(DOWN); k(ENTER); k("key"); k(ESC); k(ENTER); k("key2"); k(ENTER);
  tui.openWizard(providers); k(ESC);
  tui.openModelPick("openai", Array.from({ length: 14 }, (_, i) => "model-" + i), "model-3"); for (let i = 0; i < 12; i++) k(DOWN); k(UP); k(ENTER);
  tui.openModelPick("openai", ["a", "b"], undefined, "coder"); k(DOWN); k(ENTER);
  tui.openModelPick("openai", ["a"]); k(ESC);
  const dir = mkdtempSync(join(tmpdir(), "mimon-golden-"));
  writeFileSync(dir + "/g.png", buildPng(40, 20, (x, y) => [x * 6, y * 12, 100]));
  k("\x1b[200~" + dir + "/g.png\x1b[201~"); await new Promise((r) => setTimeout(r, 60));
  k("explain"); k(ENTER); await tui.settleAttachments(); const imgs = tui.takePendingImages();
  tui.historyPush("YOU explain"); tui.showImage(imgs[0]); await new Promise((r) => setTimeout(r, 30));
  tui.historyStream("streamed "); tui.historyStream("answer"); tui.historyStreamEnd(); tui.endBusy();
  tui.notice("a notice"); tui.showError("an error that is long enough to wrap across the box width for sure, yes indeed it is");
  tui.setChatStatus("RUNNING", 3); tui.setRuntime(42, "abcdef123456");
  const perm = tui.permission(); k("v"); log.push("perm " + (await perm));
  tui.beginBusy(); k("typed"); k(ENTER); tui.endBusy();
  tty.columns = 60; tty.rows = 20; tui.refresh(); tty.columns = 30; tty.rows = 10; tui.refresh();
  k("\t"); k("\x10"); k(ESC);
  rmSync(dir, { recursive: true, force: true });
  // the image lives in a per-run temp dir; its path must not leak into the frames
  return { output: out.join("").split(dir).join("<tmp>"), hooks: log };
}

describe("golden TUI session", () => {
  it("renders and behaves exactly as pinned", async () => {
    const saved = { name: process.env.AGENT_NAME, colors: process.env.AGENT_COLORS };
    delete process.env.AGENT_NAME;
    delete process.env.AGENT_COLORS;
    try {
      const { output, hooks } = await session();
      expect(hooks).toMatchSnapshot();
      expect({ bytes: output.length, sha256: createHash("sha256").update(output).digest("hex") }).toMatchSnapshot();
    } finally {
      if (saved.name !== undefined) process.env.AGENT_NAME = saved.name;
      if (saved.colors !== undefined) process.env.AGENT_COLORS = saved.colors;
    }
  });
});
