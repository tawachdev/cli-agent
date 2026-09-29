import { stdout } from "node:process";
import { BRAND_PALETTE, brandColors, brandName, colorForLetter, entryColor, validColorEntry, xterm256Hex } from "../shared/brand";
import { existsSync } from "node:fs";
import { imageChipName, loadImagesFromPaths, locateImagePaths, renderImage, type LoadedImage } from "./images";
import { glyphWord } from "../shared/glyphs";
import { ANSI as C } from "../shared/tokens";
import { PRODUCT_VERSION } from "../shared/version";

export { C };
export { PRODUCT_VERSION };

export interface Tty {
  write(data: string): void;
  readonly columns: number;
  readonly rows: number;
}

export function visibleLen(s: string): number {
  return s.replace(/\x1b\[[0-9;]*m/g, "").length;
}

export function WIDTH(): number {
  const cols = stdout.columns;
  if (!cols || cols < 20) return 44;
  return Math.min(cols - 2, 92);
}

export function fit(s: string): string {
  const max = Math.max(20, stdout.columns || 44) - 1;
  const plain = s.replace(/\x1b\[[0-9;]*m/g, "");
  if (plain.length <= max) return s;
  return plain.slice(0, max);
}

export function wrap(text: string, width: number): string[] {
  const out: string[] = [];
  for (const rawLine of text.split("\n")) {
    let line = "";
    for (const word of rawLine.replace(/\s+/g, " ").trim().split(" ")) {
      if ((line + " " + word).trim().length > width) {
        if (line) out.push(line);
        line = word;
      } else {
        line = (line + " " + word).trim();
      }
    }
    out.push(line);
  }
  return out;
}

function trunc(s: string, max: number): string {
  let out = "";
  let n = 0;
  for (const ch of s) {
    if (n >= max) break;
    out += ch;
    n += 1;
  }
  return out;
}

export function panel(
  out: Tty,
  label: string,
  labelColor: string,
  border: string,
  lines: string[],
): void {
  const w = WIDTH();
  const dashes = Math.max(2, w - 5 - label.length);
  out.write(border + "╭─ " + C.reset + labelColor + C.bold + label + C.reset + " " + border + "─".repeat(dashes) + "╮" + C.reset + "\n");
  for (const line of lines) {
    out.write(border + "│ " + C.reset + line.padEnd(w - 4) + " " + border + "│" + C.reset + "\n");
  }
  out.write(border + "╰" + "─".repeat(w - 2) + "╯" + C.reset + "\n");
}

export function chip(text: string, bg?: boolean): string {
  return (bg ? C.inverse : "") + C.bold + " " + text + " " + C.reset;
}

export function meter(pct: number, width = 14): string {
  const filled = Math.round((Math.min(100, pct) / 100) * width);
  return C.green + "#".repeat(filled) + C.reset + C.dim + "-".repeat(width - filled) + C.reset;
}

export function fmtSecs(ms: number): string {
  return (ms / 1000).toFixed(1) + "s";
}

function boxLines(cols: number, version: string): string[] {
  const brand = brandName();
  const palette = brandColors();
  const meta = "v" + version + " · your keys · your machine";
  const wide = glyphWord(brand, false);
  const mini = glyphWord(brand, true);
  const single = (): string[] => {
    const plain = trunc("✦ " + brand + " v" + version, Math.max(6, cols));
    return [palette[0]! + C.bold + plain.slice(0, brand.length + 2) + C.reset + C.dim + plain.slice(brand.length + 2) + C.reset];
  };
  if (!wide || !mini) return single();
  const useMini = cols < wide.width + 13;
  const art = useMini ? mini : wide;
  const contentWidth = Math.max(art.width, meta.length);
  if (cols < contentWidth + 5) return single();
  const gap = useMini ? " " : "  ";
  const lead = " ".repeat(Math.max(0, Math.floor((cols - contentWidth - 4) / 2)));
  const edge = C.dim;
  const open = lead + edge + "╭" + "─".repeat(contentWidth + 2) + "╮" + C.reset;
  const blank = lead + edge + "│" + C.reset + " ".repeat(contentWidth + 2) + edge + "│" + C.reset;
  const close = lead + edge + "╰" + "─".repeat(contentWidth + 2) + "╯" + C.reset;
  const row = (colored: string, width: number): string => {
    const l = Math.floor((contentWidth + 2 - width) / 2);
    const r = contentWidth + 2 - width - l;
    return lead + edge + "│" + C.reset + " ".repeat(l) + colored + " ".repeat(r) + edge + "│" + C.reset;
  };
  const lines: string[] = [open, blank];
  for (const cells of art.cells) {
    const colored = cells.map((cell, i) => colorForLetter(i, palette) + cell + C.reset).join(gap);
    lines.push(row(colored, art.width));
  }
  lines.push(blank);
  lines.push(row(C.dim + meta + C.reset, meta.length));
  lines.push(close);
  return lines;
}

export function splash(tty: Tty, version: string): void {
  const cols = tty.columns > 0 ? tty.columns : 40;
  tty.write("\n" + boxLines(cols, version).join("\n") + "\n\n");
}

export interface MimonTier {
  id: "mimon1" | "mimon2" | "mimon3" | "mimonMax";
  label: string;
  blurb: string;
  dot: string;
}

export interface ProviderEntry {
  name: string;
  models: string[];
  keySet: boolean;
}

export interface BindTarget {
  role: string;
  label: string;
}

export const BIND_TARGETS: BindTarget[] = [
  { role: "mimon1", get label() { return brandName() + " 1"; } },
  { role: "mimon2", get label() { return brandName() + " 2"; } },
  { role: "mimon3", get label() { return brandName() + " 3"; } },
  { role: "mimonMax", get label() { return brandName() + " MAX"; } },
  { role: "coder", label: "Coder" },
  { role: "general", label: "General" },
];

export const TIERS: MimonTier[] = [
  { id: "mimon1", get label() { return brandName() + " 1"; }, blurb: "fast · light tasks", dot: C.teal },
  { id: "mimon2", get label() { return brandName() + " 2"; }, blurb: "balanced · code · default", dot: C.cream },
  { id: "mimon3", get label() { return brandName() + " 3"; }, blurb: "deep reasoning", dot: C.green },
  { id: "mimonMax", get label() { return brandName() + " MAX"; }, blurb: "maximum strength", dot: C.gold },
];

export interface SlashCommand {
  name: string;
  description: string;
}

const COMMANDS: SlashCommand[] = [
  { name: "/new", description: "Start a fresh session" },
  { name: "/model", description: "Settings · switch " + brandName() + " model" },
  { name: "/providers", description: "Settings · cloud providers & keys" },
  { name: "/setup", description: "Setup · connect a provider & key" },
  { name: "/brand", description: "Make it yours · change name & colors" },
  { name: "/stop", description: "Abort the running turn" },
  { name: "/help", description: "Show keyboard shortcuts" },
  { name: "/exit", description: "Quit " + brandName().toLowerCase() },
];

const TIP_BASES = [
  "type / then enter opens the model settings",
  "tab cycles ",
  "drag an image into the prompt to send it to the model",
  "esc stops a running turn cold",
  "/brand changes the name & colors any time",
];

function tipsList(): string[] {
  return [
    TIP_BASES[0]!,
    TIP_BASES[1]! + brandName() + " 1 · 2 · 3 · MAX instantly",
    TIP_BASES[2]!,
    TIP_BASES[3]!,
    TIP_BASES[4]!,
  ];
}

export type Key =
  | { kind: "char"; ch: string }
  | { kind: "enter" | "backspace" | "delete" | "up" | "down" | "left" | "right" | "home" | "end" | "escape" | "tab" | "ctrl-c" | "ctrl-p" | "unknown" };

export function decodeChunk(chunk: string): { keys: Key[]; rest: string } {
  const keys: Key[] = [];
  let i = 0;
  while (i < chunk.length) {
    const ch = chunk.charAt(i);
    if (ch === "\x1b") {
      const next = chunk.charAt(i + 1);
      if (next === "") return { keys, rest: "\x1b" };
      if (next === "[") {
        let j = i + 2;
        while (j < chunk.length) {
          const c = chunk.charAt(j);
          if (c >= "@" && c <= "~") break;
          j += 1;
        }
        if (j >= chunk.length) return { keys, rest: chunk.slice(i) };
        const seq = chunk.slice(i, j + 1);
        if (seq === "\x1b[A") keys.push({ kind: "up" });
        else if (seq === "\x1b[B") keys.push({ kind: "down" });
        else if (seq === "\x1b[C") keys.push({ kind: "right" });
        else if (seq === "\x1b[D") keys.push({ kind: "left" });
        else if (seq === "\x1b[H" || seq === "\x1b[1~") keys.push({ kind: "home" });
        else if (seq === "\x1b[F" || seq === "\x1b[4~") keys.push({ kind: "end" });
        else if (seq === "\x1b[3~") keys.push({ kind: "delete" });
        i = j + 1;
        continue;
      }
      keys.push({ kind: "escape" });
      i += 1;
      continue;
    }
    if (ch === "\r") { keys.push({ kind: "enter" }); i += 1; continue; }
    if (ch === "\x7f") { keys.push({ kind: "backspace" }); i += 1; continue; }
    if (ch === "\t") { keys.push({ kind: "tab" }); i += 1; continue; }
    if (ch === "\x03") { keys.push({ kind: "ctrl-c" }); i += 1; continue; }
    if (ch === "\x10") { keys.push({ kind: "ctrl-p" }); i += 1; continue; }
    if (ch < " ") { keys.push({ kind: "unknown" }); i += 1; continue; }
    keys.push({ kind: "char", ch });
    i += 1;
  }
  return { keys, rest: "" };
}

export interface TuiHooks {
  onSubmit(task: string): void;
  onCommand(name: string): void;
  onTierChange(tier: MimonTier): void;
  onAbort(): void;
  onExit(): void;
  onSetKey(name: string, key: string): void;
  onRemoveKey(name: string): void;
  onTestProvider(name: string, model: string): void;
  onBindModel(role: string, binding: string): void;
  onWizardKey(name: string, key: string): void;
  onBrandName(name: string): void;
  onBrandColors(colors: string[]): void;
  onBrandReset(): void;
  onAddProvider(name: string, baseUrl: string, models: string[]): void;
}

export class Tui {
  tier: MimonTier = TIERS[1]!;
  private input = "";
  private cursor = 0;
  private view: "prompt" | "picker" | "permission" | "providers" | "provider" | "keyInput" | "bindTo" | "brand" | "brandName" | "brandColors" | "brandColorMode" | "brandCustomColor" | "brandGrid256" | "providerAdd" = "prompt";
  private menuIndex = 0;
  private pickerIndex = 1;
  private shown = false;
  private busy = false;
  private inputRow = 0;
  private cursorCol = 0;
  private historyIndex: number | null = null;
  private draft = "";
  private turns = 0;
  private ctxPct = 0;
  private sessionShort = "";
  private permissionResolve: ((answer: "a" | "v" | "n") => void) | null = null;
  private bindings: Record<string, string> | null = null;
  private providers: ProviderEntry[] = [];
  private providerIndex = 0;
  private openProvider: ProviderEntry | null = null;
  private providerItemIndex = 0;
  private keyBuffer = "";
  private bindModel = "";
  private wizardMode = false;
  private brandIndex = 0;
  private brandBuffer = "";
  private brandError = "";
  private brandPicks: string[] = [];
  private brandCurrent: { name: string; colors: string[]; customColors: string[] } | null = null;
  private brandColorIndex = 0;
  private brandModeIndex = 0;
  private brandSingleColor = false;
  private brandCustomColors: string[] = [];
  private statusExtra = "";
  private customColorBuffer = "";
  private customColorError = "";
  private gridIndex = 0;
  private addFields: [string, string, string] = ["", "", ""];
  private addFieldIndex = 0;
  private addError = "";
  private pendingImages: Array<{ path: string; name: string; image: LoadedImage | null }> = [];
  private pendingPaths = new Set<string>();
  private history: string[] = [];
  private workingLine = "";
  private chatLines: string[] = [];
  private bannerActive = false;
  private bannerVersion = "";
  private chatStreamOpen = false;
  private lastLines: string[] = [];
  private cursorLine = 0;


  constructor(
    private readonly tty: Tty,
    private readonly hooks: TuiHooks,
  ) {}

  private get cols(): number {
    return this.tty.columns > 0 ? this.tty.columns : 40;
  }

  private get usable(): number {
    return this.cols - 2;
  }

  private get rows(): number {
    return this.tty.rows > 0 ? this.tty.rows : 24;
  }

  setRuntime(ctxPct: number, sessionId: string): void {
    this.ctxPct = ctxPct;
    this.sessionShort = sessionId.slice(0, 8);
  }

  enableHero(version: string): void {
    this.bannerActive = true;
    this.bannerVersion = version;
    this.refresh();
  }

  private filtered(): SlashCommand[] {
    const word = this.input.slice(1);
    return COMMANDS.filter((c) => c.name.slice(1).startsWith(word));
  }

  private bar(): string {
    return C.teal + "▌" + C.reset + " ";
  }

  private innerWidth(): number {
    return Math.max(8, Math.min(this.usable - 4, 76));
  }

  private boxLead(): string {
    return " ".repeat(Math.max(0, Math.floor((this.usable - this.innerWidth() - 4) / 2)));
  }

  private boxEdge(top: boolean): string {
    const w = this.innerWidth() + 2;
    return this.boxLead() + C.dim + (top ? "╭" : "╰") + "─".repeat(w) + (top ? "╮" : "╯") + C.reset;
  }

  private boxLine(content: string): string {
    const budget = Math.max(4, this.innerWidth() - 4);
    let out = content;
    if (visibleLen(out) > budget) {
      let plain = "";
      for (const ch of out.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")) {
        if (plain.length >= budget) break;
        plain += ch;
      }
      out = C.reset + plain;
    }
    const pad = Math.max(0, this.innerWidth() - 2 - visibleLen(out));
    return this.boxLead() + C.dim + "│" + C.reset + "  " + out + " ".repeat(pad) + "  " + C.dim + "│" + C.reset;
  }

  private boxed(title: string, body: string[]): string[] {
    const dashes = Math.max(2, this.innerWidth() - 5 - title.length);
    const out: string[] = [
      this.boxLead() + C.dim + "╭─ " + C.reset + C.gold + C.bold + trunc(title, this.innerWidth() - 8) + C.reset + " " + C.dim + "─".repeat(dashes) + "╮" + C.reset,
    ];
    for (const line of body) out.push(this.boxLine(line));
    out.push(this.boxEdge(false));
    return out;
  }

  private padCell(text: string, width: number): string {
    return text + " ".repeat(Math.max(1, width - visibleLen(text)));
  }

  private renderInput(): string {
    const maxText = this.innerWidth() - 4;
    if (this.busy) {
      return C.dim + trunc("▌ working — esc to stop", maxText) + C.reset;
    }
    if (this.input === "") {
      return C.dim + trunc('Ask anything… "fix the flaky test in auth"', maxText) + C.reset;
    }
    const before = trunc(this.input.slice(0, this.cursor), maxText);
    const restBudget = Math.max(0, maxText - before.length);
    const after = trunc(this.input.slice(this.cursor), restBudget);
    return C.cream + before + C.reset + C.cream + after + C.reset;
  }

  private renderStatus(): string {
    const label = trunc(this.tier.label, Math.max(3, Math.min(9, this.innerWidth() - 3)));
    const images = this.pendingImages.length > 0 ? " · ▤" + this.pendingImages.length : "";
    const meta = trunc(this.statusExtra + " · ctx " + this.ctxPct + "% · s " + this.sessionShort + images, Math.max(0, this.innerWidth() - 7 - label.length));
    return C.teal + "●" + C.reset + " " + C.bold + C.cream + label + C.reset + C.dim + meta + C.reset;
  }

  private renderHints(): string {
    const text = "enter send · / commands · tab model · esc stop · ctrl+c exit";
    const line = C.dim + trunc(text, this.usable - 4) + C.reset;
    const pad = " ".repeat(Math.max(0, Math.floor((this.usable - visibleLen(line)) / 2)));
    return pad + line;
  }

  private renderTip(): string {
    const tip = tipsList()[this.turns % 5]!;
    const line = C.gold + "● tip " + C.reset + C.dim + trunc(tip, this.usable - 10) + C.reset;
    const pad = " ".repeat(Math.max(0, Math.floor((this.usable - visibleLen(line)) / 2)));
    return pad + line;
  }

  private renderMenu(): string[] {
    const items = this.filtered();
    if (!this.input.startsWith("/") || items.length === 0) return [];
    const maxVisible = Math.max(1, Math.min(this.rows - 6, items.length));
    const first = Math.max(0, Math.min(this.menuIndex - maxVisible + 1, items.length - maxVisible));
    const window = items.slice(first, first + maxVisible);
    const menuW = Math.min(this.usable - 2, 64);
    const lines: string[] = [];
    for (let i = 0; i < window.length; i++) {
      const item = window[i]!;
      const plain = " " + item.name.padEnd(9) + trunc(item.description, menuW - 12);
      if (first + i === this.menuIndex) {
        lines.push("  " + C.bgTeal + C.dark + C.bold + plain.padEnd(menuW) + C.reset);
      } else {
        lines.push("  " + C.bold + item.name + C.reset + C.dim + " ".repeat(Math.max(0, 9 - item.name.length)) + trunc(item.description, menuW - 12) + C.reset);
      }
    }
    return lines;
  }

  private renderPicker(): string[] {
    const titleBody = this.usable >= 22 ? "── select model " + "─".repeat(Math.max(4, Math.min(this.usable - 22, 30))) : "── model ──";
    const lines: string[] = ["  " + C.dim + trunc(titleBody, Math.max(6, this.usable - 2)) + C.reset];
    const labelBudget = Math.min(9, Math.max(3, this.usable - 6));
    const blurbBudget = this.usable - 22;
    for (let i = 0; i < TIERS.length; i++) {
      const t = TIERS[i]!;
      const sel = i === this.pickerIndex;
      const cursorCell = sel ? C.teal + "❯ " + C.reset : "  ";
      const label = sel ? C.bold + C.teal + trunc(t.label, labelBudget) + C.reset : C.bold + C.cream + trunc(t.label, labelBudget) + C.reset;
      const blurbText = this.bindings?.[t.id] ?? t.blurb;
      const blurb = blurbBudget >= 6 ? C.dim + "  " + trunc(blurbText, blurbBudget) + C.reset : "";
      lines.push("  " + cursorCell + t.dot + "● " + C.reset + label + blurb);
    }
    const footer = this.usable >= 42 ? "↑↓ move · enter select · esc cancel" : "↑↓ · enter · esc";
    lines.push("  " + C.dim + trunc(footer, Math.max(6, this.usable - 2)) + C.reset);
    return lines;
  }

  private providersLines(): string[] {
    const titleBody = this.usable >= 22 ? "── cloud providers " + "─".repeat(Math.max(4, Math.min(this.usable - 24, 28))) : "── providers ──";
    const lines: string[] = [];
    if (this.wizardMode) {
      lines.push("  " + C.gold + C.bold + "✦ welcome to " + brandName().toLowerCase() + C.reset);
      lines.push("  " + C.dim + trunc("pick a provider and paste its API key — it never leaves this machine", Math.max(6, this.usable - 2)) + C.reset);
    }
    lines.push("  " + C.dim + trunc(titleBody, Math.max(6, this.usable - 2)) + C.reset);
    const statusBudget = 12;
    const nameBudget = Math.max(8, this.usable - statusBudget - 8);
    for (let i = 0; i < this.providers.length; i++) {
      const p = this.providers[i]!;
      const sel = i === this.providerIndex;
      const cursorCell = sel ? C.teal + "❯ " + C.reset : "  ";
      const name = (sel ? C.bold + C.teal : C.bold + C.cream) + trunc(p.name, nameBudget) + C.reset;
      const status = p.keySet ? C.green + "key saved" + C.reset : C.dim + "no key" + C.reset;
      lines.push("  " + cursorCell + name + "  " + status);
    }
    if (this.providers.length === 0) lines.push("  " + C.dim + "no providers" + C.reset);
    {
      const sel = this.providerIndex === this.providers.length;
      const cursorCell = sel ? C.teal + "❯ " + C.reset : "  ";
      const text = sel ? C.bold + C.teal + "+ add provider (any OpenAI-compatible URL)" + C.reset : C.dim + "+ add provider" + C.reset;
      lines.push("  " + cursorCell + text);
    }
    const footer = this.usable >= 42 ? "↑↓ move · enter open · esc close" : "↑↓ · enter · esc";
    lines.push("  " + C.dim + trunc(footer, Math.max(6, this.usable - 2)) + C.reset);
    return lines;
  }

  private providerItems(): string[] {
    const p = this.openProvider;
    if (!p) return [];
    const items: Array<{ text: string; kind: "model" | "action" }> = p.models.map((m) => ({ text: m, kind: "model" as const }));
    items.push({ text: p.keySet ? "replace key" : "set key", kind: "action" });
    if (p.keySet) items.push({ text: "remove key", kind: "action" });
    items.push({ text: "test key", kind: "action" });
    if (this.providerItemIndex >= items.length) this.providerItemIndex = Math.max(0, items.length - 1);
    const lines: string[] = [
      "  " + C.dim + trunc("── " + p.name + (p.keySet ? " · key saved" : " · no key") + " ", Math.max(6, this.usable - 2)) + C.reset,
    ];
    const budget = Math.max(8, this.usable - 6);
    for (let i = 0; i < items.length; i++) {
      const item = items[i]!;
      const sel = i === this.providerItemIndex;
      const cursorCell = sel ? C.teal + "❯ " + C.reset : "  ";
      const text = sel ? C.bold + C.teal + trunc(item.text, budget) + C.reset : item.kind === "model" ? C.cream + trunc(item.text, budget) + C.reset : C.dim + trunc(item.text, budget) + C.reset;
      lines.push("  " + cursorCell + text);
    }
    lines.push("  " + C.dim + trunc("↑↓ move · enter select · esc back", Math.max(6, this.usable - 2)) + C.reset);
    return lines;
  }

  private keyInputLines(): string[] {
    const masked = "●".repeat(Math.min(this.keyBuffer.length, Math.max(4, this.usable - 40)));
    const body = [
      C.bold + trunc("API key for " + (this.openProvider?.name ?? ""), this.usable - 6) + C.reset,
      C.cream + masked + C.reset + C.inverse + " " + C.reset,
      C.dim + trunc("stored in your Keychain — never displayed, never logged", Math.max(6, this.usable - 6)) + C.reset,
      C.dim + trunc("enter save · esc cancel", Math.max(6, this.usable - 6)) + C.reset,
    ];
    return this.boxed("provider key", body);
  }

  private bindToLines(): string[] {
    const title = "── bind " + this.bindModel + " to ──";
    const lines: string[] = ["  " + C.dim + trunc(title, Math.max(6, this.usable - 2)) + C.reset];
    const budget = Math.max(8, this.usable - 6);
    for (let i = 0; i < BIND_TARGETS.length; i++) {
      const target = BIND_TARGETS[i]!;
      const sel = i === this.providerItemIndex;
      const cursorCell = sel ? C.teal + "❯ " + C.reset : "  ";
      const text = sel ? C.bold + C.teal + trunc(target.label, budget) + C.reset : C.bold + C.cream + trunc(target.label, budget) + C.reset;
      lines.push("  " + cursorCell + text);
    }
    lines.push("  " + C.dim + trunc("↑↓ move · enter bind · esc cancel", Math.max(6, this.usable - 2)) + C.reset);
    return lines;
  }

  private buildLines(): string[] {
    if (this.view === "permission") {
      const lines = [
        "  " + C.inverse + C.gold + C.bold + " ⛨ PERMISSION " + C.reset + C.dim + " approve to continue" + C.reset,
        this.bar() + C.gold + C.bold + "a" + C.reset + C.dim + " once  " + C.reset + C.gold + C.bold + "v" + C.reset + C.dim + " session  " + C.reset + C.gold + C.bold + "n" + C.reset + C.dim + " deny · esc denies" + C.reset,
      ];
      this.inputRow = lines.length - 1;
      return lines;
    }
    const menu = this.view === "picker" ? [] : this.renderMenu();
    const overlay =
      this.view === "picker" ? this.renderPicker()
      : this.view === "providers" ? this.providersLines()
      : this.view === "provider" ? this.providerItems()
      : this.view === "keyInput" ? this.keyInputLines()
      : this.view === "bindTo" ? this.bindToLines()
      : this.view === "brand" ? this.brandLines()
      : this.view === "brandName" ? this.brandNameLines()
      : this.view === "brandColors" ? this.brandColorsLines()
      : this.view === "brandColorMode" ? this.brandColorModeLines()
      : this.view === "brandCustomColor" ? this.customColorLines()
      : this.view === "brandGrid256" ? this.brandGridLines()
      : this.view === "providerAdd" ? this.providerAddLines()
      : [];
    const prefix = menu.length + overlay.length;
    const lines = [...menu, ...overlay];
    if (this.rows >= 4) {
      lines.push(this.boxEdge(true));
      lines.push(this.boxLine(""));
      if (this.bannerActive) {
        if (this.rows >= 24) {
          for (const bannerLine of this.bannerInnerLines()) {
            lines.push(this.boxLine("  " + bannerLine));
          }
        } else if (this.rows >= 16) {
          const brand = brandName();
          lines.push(this.boxLine("  " + C.teal + C.bold + "✦ " + brand + C.reset + C.dim + "  v" + this.bannerVersion + C.reset));
        }
        lines.push(this.boxLine(""));
      }
      const inner = Math.max(10, this.innerWidth() - 6);
      const fixedCount = lines.length + 6;
      const allow = Math.max(0, (this.rows - 1) - fixedCount - 1);
      const shown = this.chatLines.slice(-allow * 2);
      for (const logical of shown) {
        for (const visual of wrap(logical, inner)) {
          lines.push(this.boxLine("  " + visual));
        }
      }
      if (this.workingLine) lines.push(this.boxLine("  " + this.workingLine));
      lines.push(this.boxLine(""));
      lines.push(C.dim + this.boxLead() + "├" + "─".repeat(this.innerWidth() + 2) + "┤" + C.reset);
      this.inputRow = lines.length;
      lines.push(this.boxLine(this.renderInput()));
      lines.push(this.boxLine(this.renderStatus()));
      lines.push(this.boxEdge(false));
      this.inputRow = this.inputRow;
    } else {
      lines.push(this.bar() + this.renderInput());
      this.inputRow = prefix;
    }
    if (this.rows >= 9) lines.push(this.renderHints());
    if (this.rows >= 12) lines.push(this.renderTip());
    return lines;
  }

  private render(): void {
    const cols = this.tty.columns > 0 ? this.tty.columns : 80;
    const lines = this.buildLines().map((line) => {
      if (visibleLen(line) <= cols) return line;
      let plain = "";
      for (const ch of line.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")) {
        if (plain.length >= cols) break;
        plain += ch;
      }
      return C.reset + plain;
    });
    const inputRow = this.inputRow;
    const prev = this.lastLines;
    let wrote = false;
    let endLine = this.cursorLine;
    if (!this.shown || prev.length === 0) {
      if (this.shown && this.cursorLine > 0) {
        this.tty.write("\x1b[" + this.cursorLine + "A");
      }
      this.tty.write("\r\x1b[J");
      this.tty.write(lines.join("\r\n"));
      wrote = true;
      endLine = lines.length - 1;
    } else {
      const total = Math.max(prev.length, lines.length);
      const changed: number[] = [];
      for (let i = 0; i < total; i++) {
        if (prev[i] !== lines[i]) changed.push(i);
      }
      if (changed.length > 0) {
        const move = (from: number, to: number): void => {
          if (to < from) this.tty.write("\x1b[" + (from - to) + "A");
          else if (to > from) this.tty.write("\x1b[" + (to - from) + "B");
        };
        if (changed.length * 3 > lines.length) {
          const d = changed[0]!;
          move(this.cursorLine, d);
          this.tty.write("\r\x1b[J");
          this.tty.write(lines.slice(d).join("\r\n"));
          endLine = lines.length - 1;
        } else {
          let cur = this.cursorLine;
          for (const idx of changed) {
            move(cur, idx);
            this.tty.write("\r\x1b[K");
            if (idx < lines.length) this.tty.write(lines[idx]!);
            cur = idx;
          }
          endLine = changed[changed.length - 1]!;
        }
        wrote = true;
      }
    }
    if (wrote) {
      if (endLine > inputRow) this.tty.write("\x1b[" + (endLine - inputRow) + "A");
      else if (endLine < inputRow) this.tty.write("\x1b[" + (inputRow - endLine) + "B");
    } else if (this.cursorLine !== inputRow) {
      const delta = this.cursorLine - inputRow;
      this.tty.write(delta > 0 ? "\x1b[" + delta + "A" : "\x1b[" + -delta + "B");
    }
    this.tty.write("\r");
    if (this.cursorCol > 0) this.tty.write("\x1b[" + this.cursorCol + "C");
    this.lastLines = lines;
    this.cursorLine = inputRow;
    this.shown = true;
  }

  private cursorColumn(): number {
    const lead = this.boxLead().replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").length;
    return lead + 3 + trunc(this.input.slice(0, this.cursor), this.usable - 6).length;
  }

  private refresh(): void {
    if (!this.shown) {
      if (this.busy) this.show();
      return;
    }
    this.cursorCol = this.cursorColumn();
    this.render();
  }

  show(): void {
    this.cursorCol = this.cursorColumn();
    this.render();
    this.shown = true;
  }

  hide(): void {
    if (!this.shown) return;
    if (this.inputRow > 0) this.tty.write("\x1b[" + this.inputRow + "A");
    this.tty.write("\r\x1b[J");
    this.shown = false;
    this.lastLines = [];
    this.cursorLine = 0;
  }

  notice(msg: string): void {
    this.chatLines.push(C.dim + trunc(msg, Math.max(6, this.usable - 2)) + C.reset);
    this.chatStreamOpen = false;
    this.refresh();
  }

  beginBusy(): void {
    this.busy = true;
    this.turns += 1;
    this.refresh();
  }

  endBusy(): void {
    this.busy = false;
    this.show();
  }

  openPicker(bindings?: Record<string, string>): void {
    if (bindings) this.bindings = bindings;
    this.view = "picker";
    this.pickerIndex = Math.max(0, TIERS.findIndex((t) => t.id === this.tier.id));
    this.refresh();
  }

  openProviders(providers: ProviderEntry[]): void {
    this.providers = providers;
    if (this.openProvider) {
      this.openProvider = providers.find((p) => p.name === this.openProvider?.name) ?? null;
    }
    this.view = this.openProvider ? "provider" : "providers";
    this.providerIndex = Math.min(this.providerIndex, Math.max(0, providers.length - 1));
    this.refresh();
  }

  private providerAddLines(): string[] {
    const labels = ["name (a-z, 0-9, -)", "base url (https://…)", "models (comma separated)"];
    const body: string[] = [];
    const budget = Math.max(8, this.innerWidth() - 2);
    for (let i = 0; i < labels.length; i++) {
      const active = i === this.addFieldIndex;
      const marker = active ? C.teal + "❯ " + C.reset : "  ";
      const label = trunc(labels[i]!, 24);
      const value = this.addFields[i]!;
      const room = budget - label.length - 2 - (active ? 1 : 0);
      const tail = room > 4 && value.length > room ? "…" + value.slice(-(room - 1)) : value;
      const field = active
        ? C.bold + label + C.reset + "  " + C.cream + tail + C.reset + C.inverse + " " + C.reset
        : value
          ? C.dim + label + C.reset + "  " + C.dim + tail + C.reset
          : C.dim + label + C.reset;
      body.push(marker + field);
    }
    if (this.addError) {
      body.push(C.red + trunc(this.addError, this.usable - 6) + C.reset);
    }
    body.push(C.dim + trunc("enter next · esc cancel", Math.max(6, this.usable - 6)) + C.reset);
    return this.boxed("add provider · any OpenAI-compatible endpoint", body);
  }

  private brandLines(): string[] {
    const current = this.brandCurrent;
    const title = current
      ? "make it yours · " + current.name + " · " + current.colors.join(" + ")
      : "── make it yours ──";
    const items = ["change name", "change colors", "reset to defaults"];
    const body: string[] = [];
    const budget = Math.max(8, this.usable - 6);
    for (let i = 0; i < items.length; i++) {
      const sel = i === this.brandIndex;
      const cursorCell = sel ? C.teal + "❯ " + C.reset : "  ";
      const text = sel ? C.bold + C.teal + items[i]! + C.reset : C.bold + C.cream + items[i]! + C.reset;
      body.push(cursorCell + text);
    }
    body.push(C.dim + trunc("↑↓ move · enter select · esc close", Math.max(6, this.usable - 6)) + C.reset);
    return this.boxed(title, body);
  }

  private brandNameLines(): string[] {
    const body = [
      C.bold + "New name:" + C.reset + " " + C.cream + this.brandBuffer + C.reset + C.inverse + " " + C.reset,
    ];
    if (this.brandError) {
      body.push(C.red + trunc(this.brandError, this.usable - 6) + C.reset);
    }
    body.push(C.dim + trunc("2-12 letters · enter save · esc back", Math.max(6, this.usable - 6)) + C.reset);
    return this.boxed("brand name", body);
  }

  private paletteEntries(): string[] {
    return [...Object.keys(BRAND_PALETTE), ...this.brandCustomColors, "custom hex…", "all 256 colors…"];
  }

  private brandColorsLines(): string[] {
    const names = this.paletteEntries();
    const total = this.brandSingleColor ? 1 : this.brandCurrent?.name.length ?? 1;
    const letter = this.brandCurrent?.name[this.brandPicks.length] ?? "?";
    const preview = (this.brandCurrent?.name ?? "")
      .split("")
      .map((ch, i) => (i < this.brandPicks.length ? entryColor(this.brandPicks[i]!) + C.bold + ch + C.reset : C.dim + ch + C.reset))
      .join(" ");
    const body: string[] = [
      C.bold + "preview:" + C.reset + "  " + preview,
      "",
    ];
    const perRow = 2;
    const cellWidth = Math.max(14, Math.floor((this.innerWidth() - 6) / perRow));
    for (let row = 0; row < names.length; row += perRow) {
      const cells: string[] = [];
      for (let col = 0; col < perRow; col++) {
        const index = row + col;
        if (index >= names.length) break;
        const name = names[index]!;
        const sel = index === this.brandColorIndex;
        const isCustom = this.brandCustomColors.includes(name);
        const swatch = name === "custom hex…"
          ? "\x1b[38;5;80m" + "＃" + C.reset
          : name === "all 256 colors…"
            ? "\x1b[38;5;220m" + "▤" + C.reset
            : isCustom
              ? entryColor(name) + "██" + C.reset
              : BRAND_PALETTE[name] + "██" + C.reset;
        const cell = (sel ? C.teal + "❯ " + C.reset : "   ") + swatch + " " + (sel ? C.bold + C.teal + name : C.cream + name) + C.reset;
        cells.push(this.padCell(cell, cellWidth));
      }
      body.push(cells.join(""));
    }
    const stage = this.brandSingleColor
      ? "one color for the whole name"
      : "picking for letter " + letter + " (" + (this.brandPicks.length + 1) + "/" + total + ")";
    body.push(C.dim + trunc(stage + " · enter pick · esc undo", Math.max(6, this.usable - 6)) + C.reset);
    return this.boxed("brand colors", body);
  }

  private customColorLines(): string[] {
    const entry = validColorEntry(this.customColorBuffer);
    const swatch = entry ? entryColor(entry) + "██" + C.reset : C.dim + "██" + C.reset;
    const body = [
      C.bold + "Hex color:" + C.reset + " " + C.cream + this.customColorBuffer + C.reset + C.inverse + " " + C.reset + "  " + swatch,
    ];
    if (this.customColorError) {
      body.push(C.red + trunc(this.customColorError, this.usable - 6) + C.reset);
    }
    body.push(C.dim + trunc("#rrggbb — e.g. #7c3aed · enter apply · esc back", Math.max(6, this.usable - 6)) + C.reset);
    return this.boxed("custom color", body);
  }

  private gridPerRow(): number {
    return Math.max(6, Math.floor((this.innerWidth() - 2) / 3));
  }

  private brandGridLines(): string[] {
    const letter = this.brandSingleColor ? "" : this.brandCurrent?.name[this.brandPicks.length] ?? "?";
    const stage = this.brandSingleColor
      ? "one color for the whole name"
      : "picking for letter " + letter + " (" + (this.brandPicks.length + 1) + "/" + (this.brandCurrent?.name.length ?? 1) + ")";
    const picked = xterm256Hex(this.gridIndex);
    const body: string[] = [
      C.bold + "preview:" + C.reset + "  " + entryColor(picked) + "████████" + C.reset + "  " + C.dim + picked + C.reset,
      "",
    ];
    const perRow = this.gridPerRow();
    const maxRows = Math.max(3, Math.min(10, this.rows - 16));
    const totalRows = Math.ceil(256 / perRow);
    let firstRow = Math.max(0, Math.min(Math.floor(this.gridIndex / perRow) - Math.floor(maxRows / 2), totalRows - maxRows));
    const lastRow = Math.min(totalRows, firstRow + maxRows);
    if (firstRow > 0) body.push(C.dim + "  ↑ more" + C.reset);
    for (let row = firstRow; row < lastRow; row++) {
      const cells: string[] = [];
      for (let col = 0; col < perRow; col++) {
        const index = row * perRow + col;
        if (index >= 256) break;
        const color = "\x1b[38;5;" + index + "m██" + C.reset;
        const marker = index === this.gridIndex ? C.teal + "❯" + C.reset : " ";
        cells.push(marker + color);
      }
      body.push(cells.join(""));
    }
    if (lastRow < totalRows) body.push(C.dim + "  ↓ more" + C.reset);
    body.push(C.dim + trunc(stage + " · ↑↓←→ move · enter pick · esc back", Math.max(6, this.usable - 6)) + C.reset);
    return this.boxed("all 256 colors", body);
  }

  private brandColorModeLines(): string[] {
    const items = ["one color for the whole name", "a color for each letter"];
    const body: string[] = [];
    for (let i = 0; i < items.length; i++) {
      const sel = i === this.brandModeIndex;
      const cursorCell = sel ? C.teal + "❯ " + C.reset : "  ";
      const text = sel ? C.bold + C.teal + items[i]! + C.reset : C.bold + C.cream + items[i]! + C.reset;
      body.push(cursorCell + text);
    }
    body.push(C.dim + trunc("↑↓ move · enter select · esc back", Math.max(6, this.usable - 6)) + C.reset);
    return this.boxed("brand colors", body);
  }

  openWizard(providers: ProviderEntry[]): void {
    this.providers = providers;
    this.openProvider = null;
    this.wizardMode = true;
    this.view = "providers";
    this.providerIndex = 0;
    this.refresh();
  }

  exitWizard(): void {
    this.wizardMode = false;
    this.view = "prompt";
    this.refresh();
  }

  openBrand(current: { name: string; colors: string[]; customColors?: string[] }): void {
    this.brandCustomColors = current.customColors ?? [];
    this.brandCurrent = { name: current.name, colors: current.colors, customColors: this.brandCustomColors };
    this.brandError = "";
    this.brandPicks = [];
    this.view = "brand";
    this.brandIndex = 0;
    this.refresh();
  }

  setChatStatus(state: string, steps: number): void {
    this.statusExtra = state === "IDLE" && steps === 0 ? "" : " · " + state + " · steps " + steps;
    this.refresh();
  }

  setBrandCustomColors(colors: string[]): void {
    this.brandCustomColors = colors;
    if (this.view === "brandColors") this.refresh();
  }

  refreshBrand(): void {
    this.refresh();
  }

  onResize(): void {
    if (this.busy && this.view !== "permission") return;
    this.tty.write("\x1b[2J\x1b[H");
    this.lastLines = [];
    this.cursorLine = 0;
    this.shown = false;
    this.show();
  }

  permission(): Promise<"a" | "v" | "n"> {
    this.view = "permission";
    this.show();
    return new Promise((resolve) => {
      this.permissionResolve = resolve;
    });
  }

  private resolvePermission(answer: "a" | "v" | "n"): void {
    const resolve = this.permissionResolve;
    this.permissionResolve = null;
    this.view = "prompt";
    this.hide();
    resolve?.(answer);
  }

  private insert(ch: string): void {
    if (visibleLen(this.input) >= this.usable - 6) return;
    this.input = this.input.slice(0, this.cursor) + ch + this.input.slice(this.cursor);
    this.cursor += 1;
    this.menuIndex = 0;
    this.historyIndex = null;
    this.detectAttachments();
  }

  private detectAttachments(): void {
    const located = locateImagePaths(this.input);
    for (const hit of located.reverse()) {
      if (this.pendingPaths.has(hit.path)) continue;
      if (!existsSync(hit.path)) continue;
      this.input = this.input.slice(0, hit.start) + this.input.slice(hit.end);
      this.cursor = Math.min(this.cursor, this.input.length);
      this.pendingPaths.add(hit.path);
      this.pendingImages.push({ path: hit.path, name: imageChipName(hit.path), image: null });
      void this.loadPending(hit.path);
    }
    if (located.length > 0) this.refresh();
  }

  private async loadPending(path: string): Promise<void> {
    const { images, errors } = await loadImagesFromPaths([path]);
    const entry = this.pendingImages.find((p) => p.path === path);
    if (entry && images[0]) {
      entry.image = images[0]!;
      this.previewImage(images[0]!);
    } else if (entry && errors[0]) {
      this.pendingImages = this.pendingImages.filter((p) => p.path !== path);
      this.pendingPaths.delete(path);
      this.notice("✘ " + errors[0]!);
    }
  }

  private previewImage(image: LoadedImage): void {
    const wasShown = this.shown;
    this.hide();
    renderImage(this.tty, image, 24);
    this.tty.write(C.dim + "  ▤ " + image.name + " attached — sent with your next message" + C.reset + "\n");
    if (wasShown || !this.busy) this.show();
  }

  showError(message: string): void {
    const width = Math.max(10, this.innerWidth() - 6);
    const wrapped = wrap(message.replace(/\s+/g, " ").trim(), width);
    wrapped.forEach((l, i) => {
      this.chatLines.push(C.red + (i === 0 ? "✘ " : "  ") + l + C.reset);
    });
    this.refresh();
  }

  historyPush(line: string): void {
    this.chatLines.push(line);
    this.chatStreamOpen = false;
    this.refresh();
  }

  historyStream(text: string): void {
    if (this.chatLines.length === 0 || !this.chatStreamOpen) {
      this.chatLines.push(text);
      this.chatStreamOpen = true;
    } else {
      this.chatLines[this.chatLines.length - 1]! += text;
    }
    this.refresh();
  }

  private bannerInnerLines(): string[] {
    const brand = brandName();
    const palette = brandColors();
    const wide = glyphWord(brand, false);
    const mini = glyphWord(brand, true);
    if (!wide || !mini) return [];
    const useMini = this.innerWidth() < wide.width + 8;
    const art = useMini ? mini : wide;
    const gap = useMini ? " " : "  ";
    const lines: string[] = [];
    for (const cells of art.cells) {
      const colored = cells.map((cell, i) => colorForLetter(i, palette) + cell + C.reset).join(gap);
      lines.push(colored);
    }
    const meta = this.innerWidth() < 46
      ? "v" + this.bannerVersion
      : "v" + this.bannerVersion + " · your keys · your machine";
    lines.push(C.dim + meta + C.reset);
    return lines;
  }

  historyStreamEnd(): void {
    this.chatStreamOpen = false;
  }

  historyReplaceLast(line: string): void {
    if (this.chatLines.length === 0) this.chatLines.push(line);
    else this.chatLines[this.chatLines.length - 1]! = line;
    this.refresh();
  }

  printAbove(lines: string[]): void {
    if (lines.length === 0) return;
    if (this.shown && this.inputRow > 0) {
      this.tty.write("\x1b[" + this.inputRow + "A");
    }
    this.tty.write("\r\x1b[J");
    for (const line of lines) this.tty.write(line + "\n");
    this.lastLines = [];
    this.cursorLine = 0;
    this.shown = false;
    this.show();
  }

  streamStart(): void {
    if (this.shown) this.hide();
  }

  stream(text: string): void {
    this.tty.write(text);
  }

  streamEnd(): void {
    this.tty.write(C.reset + "\n");
    this.show();
  }

  takePendingImages(): LoadedImage[] {
    const taken = this.pendingImages.flatMap((p) => (p.image ? [p.image] : []));
    const missing = this.pendingImages.filter((p) => !p.image).map((p) => p.path);
    this.pendingImages = [];
    this.pendingPaths.clear();
    for (const path of missing) this.notice("✘ " + path + " — could not be loaded, skipped");
    return taken;
  }

  hasPendingImages(): boolean {
    return this.pendingImages.length > 0;
  }

  clearPendingImages(): void {
    this.pendingImages = [];
    this.pendingPaths.clear();
  }

  private recall(direction: "up" | "down"): void {
    if (this.history.length === 0) return;
    if (direction === "up") {
      if (this.historyIndex === null) {
        this.draft = this.input;
        this.historyIndex = this.history.length - 1;
      } else if (this.historyIndex > 0) {
        this.historyIndex -= 1;
      }
    } else {
      if (this.historyIndex === null) return;
      this.historyIndex += 1;
      if (this.historyIndex >= this.history.length) {
        this.historyIndex = null;
        this.input = this.draft;
        this.cursor = this.input.length;
        return;
      }
    }
    this.input = this.history[this.historyIndex] ?? "";
    this.cursor = this.input.length;
  }

  cycleTier(): void {
    const i = TIERS.findIndex((t) => t.id === this.tier.id);
    const next = TIERS[(i + 1) % TIERS.length]!;
    this.setTier(next);
    this.hooks.onTierChange(next);
    this.notice("✓ model set to " + next.label);
  }

  setTier(tier: MimonTier): void {
    this.tier = tier;
    this.refresh();
  }

  private pickTier(): void {
    const t = TIERS[this.pickerIndex]!;
    this.view = "prompt";
    this.setTier(t);
    this.hooks.onTierChange(t);
    this.notice("✓ model set to " + t.label);
  }

  private applyColorPick(entry: string): void {
    this.brandPicks.push(entry);
    const total = this.brandSingleColor ? 1 : this.brandCurrent?.name.length ?? 1;
    if (this.brandPicks.length >= total) {
      const picks = this.brandPicks;
      this.brandPicks = [];
      this.view = "prompt";
      this.refresh();
      this.hooks.onBrandColors(picks);
      return;
    }
    this.brandColorIndex = 0;
    this.refresh();
  }

  private selectBrandItem(): void {
    if (this.brandIndex === 0) {
      this.brandBuffer = "";
      this.brandError = "";
      this.view = "brandName";
      this.refresh();
      return;
    }
    if (this.brandIndex === 1) {
      this.brandModeIndex = 0;
      this.view = "brandColorMode";
      this.refresh();
      return;
    }
    this.view = "prompt";
    this.refresh();
    this.hooks.onBrandReset();
  }

  private selectProviderItem(): void {
    if (this.view === "providers") {
      if (this.providerIndex >= this.providers.length) {
        this.addFields = ["", "", ""];
        this.addFieldIndex = 0;
        this.addError = "";
        this.view = "providerAdd";
        this.refresh();
        return;
      }
      const p = this.providers[this.providerIndex];
      if (!p) return;
      this.openProvider = p;
      this.providerItemIndex = 0;
      this.view = this.wizardMode ? "keyInput" : "provider";
      this.refresh();
      return;
    }
    if (this.view === "provider") {
      const p = this.openProvider;
      if (!p) return;
      if (this.providerItemIndex < p.models.length) {
        this.bindModel = p.models[this.providerItemIndex] ?? "";
        this.providerItemIndex = 0;
        this.view = "bindTo";
        this.refresh();
        return;
      }
      const actions = p.keySet ? ["set", "remove", "test"] : ["set", "test"];
      const action = actions[this.providerItemIndex - p.models.length];
      if (action === "set") {
        this.keyBuffer = "";
        this.view = "keyInput";
        this.refresh();
      } else if (action === "remove") {
        this.hooks.onRemoveKey(p.name);
      } else if (action === "test") {
        this.hooks.onTestProvider(p.name, p.models[0] ?? "");
      }
      return;
    }
    if (this.view === "bindTo") {
      const target = BIND_TARGETS[this.providerItemIndex];
      const p = this.openProvider;
      if (!target || !p || !this.bindModel) return;
      const binding = p.name + "/" + this.bindModel;
      this.view = "prompt";
      this.openProvider = null;
      this.refresh();
      this.hooks.onBindModel(target.role, binding);
    }
  }

  handleKey(key: Key): void {
    if (key.kind === "ctrl-c") {
      this.hooks.onExit();
      return;
    }
    if (this.view === "permission") {
      if (key.kind === "char" && key.ch === "a") this.resolvePermission("a");
      if (key.kind === "char" && key.ch === "v") this.resolvePermission("v");
      if (key.kind === "char" && key.ch === "n") this.resolvePermission("n");
      if (key.kind === "escape") this.resolvePermission("n");
      return;
    }
    if (this.busy) {
      if (key.kind === "escape") this.hooks.onAbort();
      return;
    }
    if (this.view === "picker") {
      if (key.kind === "up") {
        this.pickerIndex = (this.pickerIndex + TIERS.length - 1) % TIERS.length;
        this.refresh();
      }
      if (key.kind === "down") {
        this.pickerIndex = (this.pickerIndex + 1) % TIERS.length;
        this.refresh();
      }
      if (key.kind === "enter") this.pickTier();
      if (key.kind === "escape") {
        this.view = "prompt";
        this.refresh();
      }
      return;
    }
    if (this.view === "keyInput") {
      if (key.kind === "char") {
        this.keyBuffer += key.ch;
        this.refresh();
      } else if (key.kind === "backspace") {
        this.keyBuffer = this.keyBuffer.slice(0, -1);
        this.refresh();
      } else if (key.kind === "enter") {
        const name = this.openProvider?.name ?? "";
        const keyValue = this.keyBuffer;
        this.keyBuffer = "";
        if (this.wizardMode) this.openProvider = null;
        this.view = this.wizardMode ? "providers" : "provider";
        this.refresh();
        if (name && keyValue) {
          if (this.wizardMode) this.hooks.onWizardKey(name, keyValue);
          else this.hooks.onSetKey(name, keyValue);
        }
      } else if (key.kind === "escape") {
        this.keyBuffer = "";
        if (this.wizardMode) this.openProvider = null;
        this.view = this.wizardMode ? "providers" : "provider";
        this.refresh();
      }
      return;
    }
    if (this.view === "brand") {
      if (key.kind === "up") {
        this.brandIndex = (this.brandIndex + 2) % 3;
        this.refresh();
      }
      if (key.kind === "down") {
        this.brandIndex = (this.brandIndex + 1) % 3;
        this.refresh();
      }
      if (key.kind === "enter") this.selectBrandItem();
      if (key.kind === "escape") {
        this.view = "prompt";
        this.refresh();
      }
      return;
    }
    if (this.view === "brandName") {
      if (key.kind === "char" && this.brandBuffer.length < 12) {
        this.brandBuffer += key.ch;
        this.brandError = "";
        this.refresh();
      } else if (key.kind === "backspace") {
        this.brandBuffer = this.brandBuffer.slice(0, -1);
        this.refresh();
      } else if (key.kind === "enter") {
        if (/^[A-Za-z]{2,12}$/.test(this.brandBuffer)) {
          const name = this.brandBuffer.toUpperCase();
          this.brandBuffer = "";
          this.brandError = "";
          this.view = "prompt";
          this.refresh();
          this.hooks.onBrandName(name);
        } else {
          this.brandError = "name must be 2-12 letters";
          this.refresh();
        }
      } else if (key.kind === "escape") {
        this.brandBuffer = "";
        this.brandError = "";
        this.view = "brand";
        this.refresh();
      }
      return;
    }
    if (this.view === "brandColorMode") {
      if (key.kind === "up" || key.kind === "down") {
        this.brandModeIndex = (this.brandModeIndex + 1) % 2;
        this.refresh();
      }
      if (key.kind === "enter") {
        this.brandSingleColor = this.brandModeIndex === 0;
        this.brandPicks = [];
        this.brandColorIndex = 0;
        this.view = "brandColors";
        this.refresh();
      }
      if (key.kind === "escape") {
        this.view = "brand";
        this.refresh();
      }
      return;
    }
    if (this.view === "brandColors") {
      const names = this.paletteEntries();
      const count = names.length;
      const total = this.brandSingleColor ? 1 : this.brandCurrent?.name.length ?? 1;
      const move = (delta: number) => {
        this.brandColorIndex = (this.brandColorIndex + delta + count) % count;
        this.refresh();
      };
      if (key.kind === "up") return move(-2);
      if (key.kind === "down") return move(2);
      if (key.kind === "left") return move(-1);
      if (key.kind === "right") return move(1);
      if (key.kind === "enter") {
        const picked = names[this.brandColorIndex]!;
        if (picked === "custom hex…") {
          this.customColorBuffer = "";
          this.customColorError = "";
          this.view = "brandCustomColor";
          this.refresh();
          return;
        }
        if (picked === "all 256 colors…") {
          this.gridIndex = 16;
          this.view = "brandGrid256";
          this.refresh();
          return;
        }
        this.applyColorPick(picked);
        return;
      }
      if (key.kind === "escape") {
        if (this.brandPicks.length > 0) {
          this.brandPicks.pop();
          this.refresh();
        } else {
          this.view = "brand";
          this.refresh();
        }
      }
      return;
    }
    if (this.view === "brandCustomColor") {
      if (key.kind === "char" && this.customColorBuffer.length < 9) {
        this.customColorBuffer += key.ch;
        this.customColorError = "";
        this.refresh();
      } else if (key.kind === "backspace") {
        this.customColorBuffer = this.customColorBuffer.slice(0, -1);
        this.refresh();
      } else if (key.kind === "enter") {
        const entry = validColorEntry(this.customColorBuffer);
        if (!entry) {
          this.customColorError = "use #rrggbb — six hex digits";
          this.refresh();
          return;
        }
        this.customColorBuffer = "";
        this.customColorError = "";
        this.view = "brandColors";
        this.applyColorPick(entry);
        return;
      } else if (key.kind === "escape") {
        this.customColorBuffer = "";
        this.customColorError = "";
        this.view = "brandColors";
        this.refresh();
      }
      return;
    }
    if (this.view === "brandGrid256") {
      const perRow = this.gridPerRow();
      const move = (delta: number) => {
        this.gridIndex = Math.max(0, Math.min(255, this.gridIndex + delta));
        this.refresh();
      };
      if (key.kind === "up") return move(-perRow);
      if (key.kind === "down") return move(perRow);
      if (key.kind === "left") return move(-1);
      if (key.kind === "right") return move(1);
      if (key.kind === "enter") {
        const hex = xterm256Hex(this.gridIndex);
        this.view = "brandColors";
        this.applyColorPick(hex);
        return;
      }
      if (key.kind === "escape") {
        this.view = "brandColors";
        this.refresh();
      }
      return;
    }
    if (this.view === "providerAdd") {
      const label = this.addFieldIndex === 0 ? "name" : this.addFieldIndex === 1 ? "base url" : "models";
      if (key.kind === "char" && this.addFields[this.addFieldIndex]!.length < 200) {
        this.addFields[this.addFieldIndex] = this.addFields[this.addFieldIndex]! + key.ch;
        this.addError = "";
        this.refresh();
      } else if (key.kind === "backspace") {
        this.addFields[this.addFieldIndex] = this.addFields[this.addFieldIndex]!.slice(0, -1);
        this.refresh();
      } else if (key.kind === "up" && this.addFieldIndex > 0) {
        this.addFieldIndex -= 1;
        this.addError = "";
        this.refresh();
      } else if (key.kind === "down" && this.addFieldIndex < 2) {
        this.addFieldIndex += 1;
        this.refresh();
      } else if (key.kind === "enter") {
        const [name, url, models] = this.addFields;
        if (this.addFieldIndex < 2 && !this.addFields[this.addFieldIndex]) {
          this.addError = label + " is required";
          this.refresh();
          return;
        }
        if (this.addFieldIndex === 0 && !/^[a-z0-9][a-z0-9-]*$/.test(name!)) {
          this.addError = "name: lowercase letters, digits, -";
          this.refresh();
          return;
        }
        if (this.addFieldIndex === 1 && !/^https:\/\//.test(url!) && !/^http:\/\/127\.0\.0\.1/.test(url!)) {
          this.addError = "url must be https:// (or http://127.0.0.1)";
          this.refresh();
          return;
        }
        if (this.addFieldIndex < 2) {
          this.addFieldIndex += 1;
          this.refresh();
          return;
        }
        const list = (models ?? "").split(",").map((m) => m.trim()).filter(Boolean);
        this.addFields = ["", "", ""];
        this.addFieldIndex = 0;
        this.addError = "";
        this.view = "providers";
        this.refresh();
        this.hooks.onAddProvider(name!, url!, list);
      } else if (key.kind === "escape") {
        this.addFields = ["", "", ""];
        this.addFieldIndex = 0;
        this.addError = "";
        this.view = "providers";
        this.refresh();
      }
      return;
    }
    if (this.view === "providers" || this.view === "provider" || this.view === "bindTo") {
      const count =
        this.view === "providers" ? this.providers.length + 1
        : this.view === "bindTo" ? BIND_TARGETS.length
        : (this.openProvider?.models.length ?? 0) + (this.openProvider?.keySet ? 3 : 2);
      if (count === 0) return;
      const move = (delta: number) => {
        if (this.view === "providers") {
          this.providerIndex = (this.providerIndex + delta + count) % count;
        } else {
          this.providerItemIndex = (this.providerItemIndex + delta + count) % count;
        }
        this.refresh();
      };
      if (key.kind === "escape") {
        if (this.view === "provider") {
          this.openProvider = null;
          this.view = "providers";
        } else if (this.view === "bindTo") {
          this.view = "provider";
        } else if (this.wizardMode) {
          this.exitWizard();
          return;
        } else {
          this.view = "prompt";
        }
        this.refresh();
        return;
      }
      if (key.kind === "up") return move(-1);
      if (key.kind === "down") return move(1);
      if (key.kind === "enter") return this.selectProviderItem();
      return;
    }
    this.handlePromptKey(key);
  }

  private handlePromptKey(key: Key): void {
    const menuOpen = this.input.startsWith("/") && this.filtered().length > 0;
    switch (key.kind) {
      case "char":
        this.insert(key.ch);
        break;
      case "backspace":
        if (this.cursor > 0) {
          this.input = this.input.slice(0, this.cursor - 1) + this.input.slice(this.cursor);
          this.cursor -= 1;
        }
        break;
      case "delete":
        this.input = this.input.slice(0, this.cursor) + this.input.slice(this.cursor + 1);
        break;
      case "left":
        this.cursor = Math.max(0, this.cursor - 1);
        break;
      case "right":
        this.cursor = Math.min(this.input.length, this.cursor + 1);
        break;
      case "home":
        this.cursor = 0;
        break;
      case "end":
        this.cursor = this.input.length;
        break;
      case "up":
        if (menuOpen) {
          this.menuIndex = Math.max(0, this.menuIndex - 1);
        } else {
          this.recall("up");
        }
        break;
      case "down":
        if (menuOpen) {
          this.menuIndex = Math.min(this.filtered().length - 1, this.menuIndex + 1);
        } else {
          this.recall("down");
        }
        break;
      case "tab":
        this.cycleTier();
        return;
      case "ctrl-p":
        this.input = "/";
        this.cursor = 1;
        this.menuIndex = 0;
        break;
      case "escape":
        this.input = "";
        this.cursor = 0;
        this.menuIndex = 0;
        if (this.pendingImages.length > 0) {
          this.clearPendingImages();
          this.notice("· attachments cleared ·");
          return;
        }
        break;
      case "enter": {
        if (menuOpen) {
          const cmd = this.filtered()[Math.min(this.menuIndex, this.filtered().length - 1)]!;
          this.input = "";
          this.cursor = 0;
          this.menuIndex = 0;
          this.refresh();
          this.hooks.onCommand(cmd.name);
          return;
        }
        const task = this.input.trim();
        if (!task) return;
        if (this.history[this.history.length - 1] !== task) this.history.push(task);
        this.historyIndex = null;
        this.input = "";
        this.cursor = 0;
        this.beginBusy();
        this.hooks.onSubmit(task);
        return;
      }
      case "unknown":
        return;
    }
    this.refresh();
  }
}
