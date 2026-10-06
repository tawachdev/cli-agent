import { stdout, cwd } from "node:process";
import { join } from "node:path";
import { BRAND_PALETTE, brandColors, brandName, colorForLetter, entryColor, validColorEntry, xterm256Hex } from "../shared/brand";
import { existsSync } from "node:fs";
import { saveClipboardImage } from "./clipboard";
import { fallbackPanel, imageChipName, imageSupport, itermImagePayload, kittyImagePayload, loadImagesFromPaths, locateImagePaths, MAX_IMAGES, pixelPreviewLines, type ImageSupport, type LoadedImage, type LocatedImage } from "./images";
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

const WIDE_CHAR = /[\u1100-\u115F\u2329\u232A\u2E80-\u303E\u3041-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA000-\uA4CF\uA960-\uA97F\uAC00-\uD7A3\uF900-\uFAFF\uFE10-\uFE19\uFE30-\uFE6F\uFF01-\uFF60\uFFE0-\uFFE6\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F7E0}-\u{1F7EB}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FAFF}\u{20000}-\u{2FFFD}\u{30000}-\u{3FFFD}]/u;
const ZERO_WIDTH = /[\p{M}\u200B\u200C\u200D\u2060\uFEFF\x00]/u;
const PASTE_INPUT_CAP = 4096;

function charWidth(ch: string): number {
  if (ZERO_WIDTH.test(ch)) return 0;
  if (WIDE_CHAR.test(ch)) return 2;
  return 1;
}

export function visibleLen(s: string): number {
  let n = 0;
  for (const ch of s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")) n += charWidth(ch);
  return n;
}

export function plainClip(s: string, max: number): string {
  let out = "";
  let n = 0;
  let i = 0;
  let sawEscape = false;
  while (i < s.length) {
    if (s[i] === "\x1b") {
      const m = /^\x1b\[[0-9;?]*[A-Za-z]/.exec(s.slice(i));
      if (m) {
        out += m[0];
        sawEscape = true;
        i += m[0].length;
        continue;
      }
    }
    const code = s.codePointAt(i)!;
    const ch = String.fromCodePoint(code);
    const w = charWidth(ch);
    if (n + w > max) break;
    out += ch;
    n += w;
    i += ch.length;
  }
  return sawEscape ? out + C.reset : out;
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
    const w = charWidth(ch);
    if (n + w > max) break;
    out += ch;
    n += w;
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
  | { kind: "enter" | "backspace" | "delete" | "up" | "down" | "left" | "right" | "home" | "end" | "escape" | "tab" | "ctrl-c" | "ctrl-p" | "unknown" | "paste-start" | "paste-end" };

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
        else if (seq === "\x1b[200~") keys.push({ kind: "paste-start" });
        else if (seq === "\x1b[201~") keys.push({ kind: "paste-end" });
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
  onWizardModel(name: string, model: string): void;
  onTierModelPick(role: string): void;
  onBrandName(name: string): void;
  onBrandColors(colors: string[]): void;
  onBrandReset(): void;
  onAddProvider(name: string, baseUrl: string, models: string[]): void;
}

export interface TuiOptions {
  clipboardSave?: (destDir: string) => Promise<string | null>;
  imageSupport?: ImageSupport;
}

const defaultClipboardSave = (destDir: string): Promise<string | null> => saveClipboardImage(destDir);

export class Tui {
  tier: MimonTier = TIERS[1]!;
  private input = "";
  private cursor = 0;
  private view: "prompt" | "picker" | "permission" | "providers" | "provider" | "keyInput" | "bindTo" | "brand" | "brandName" | "brandColors" | "brandColorMode" | "brandCustomColor" | "brandGrid256" | "providerAdd" | "modelPick" | "help" = "prompt";
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
  private inlineSeq = 0;
  private inlinePayloads = new Map<string, string>();
  private imageFeed: Array<{ token: string; rows: number; start: number }> = [];
  private customColorBuffer = "";
  private customColorError = "";
  private gridIndex = 0;
  private addFields: [string, string, string] = ["", "", ""];
  private addFieldIndex = 0;
  private addError = "";
  private pendingImages: Array<{ path: string; name: string; image: LoadedImage | null; preview: string[] }> = [];
  private pendingPaths = new Set<string>();
  private recovering = new Set<string>();
  private history: string[] = [];
  private workingLine = "";
  private chatLines: string[] = [];
  private helpLines: string[] = [];
  private bannerActive = false;
  private bannerVersion = "";
  private chatStreamOpen = false;
  private lastLines: string[] = [];
  private lastCols = 0;
  private lastRows = 0;
  private resizeTimer: ReturnType<typeof setTimeout> | null = null;
  private pasting = false;
  private pasteBreak = false;
  private modelPickProvider = "";
  private modelPickList: string[] = [];
  private modelPickIndex = 0;
  private modelPickOffset = 0;
  private modelPickRole = "";


  constructor(
    private readonly tty: Tty,
    private readonly hooks: TuiHooks,
    private readonly options: TuiOptions = {},
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

  private boxEdge(top: boolean, bare = false): string {
    const w = this.innerWidth() + 2;
    return (bare ? "" : this.boxLead()) + C.dim + (top ? "╭" : "╰") + "─".repeat(w) + (top ? "╮" : "╯") + C.reset;
  }

  private boxLine(content: string, bare = false): string {
    const budget = Math.max(4, this.innerWidth() - 4);
    let out = content;
    if (visibleLen(out) > budget) {
      out = C.reset + plainClip(out, budget);
    }
    const pad = Math.max(0, this.innerWidth() - 2 - visibleLen(out));
    return (bare ? "" : this.boxLead()) + C.dim + "│" + C.reset + "  " + out + " ".repeat(pad) + "  " + C.dim + "│" + C.reset;
  }

  private nestedWidth(): number {
    return Math.max(12, this.innerWidth() - 8);
  }

  private boxed(title: string, body: string[]): string[] {
    const total = this.nestedWidth() + 2;
    const titleText = trunc(title, total - 10);
    const dashes = Math.max(2, total - 5 - titleText.length);
    const out: string[] = [
      C.dim + "╭─ " + C.reset + C.gold + C.bold + titleText + C.reset + " " + C.dim + "─".repeat(dashes) + "╮" + C.reset,
    ];
    for (const line of body) {
      let content = line;
      if (visibleLen(content) > total - 2) content = C.reset + plainClip(content, total - 2);
      const pad = Math.max(0, total - 2 - visibleLen(content));
      out.push(C.dim + "│" + C.reset + content + " ".repeat(pad) + C.dim + "│" + C.reset);
    }
    out.push(C.dim + "╰" + "─".repeat(total - 2) + "╯" + C.reset);
    return out;
  }

  private padCell(text: string, width: number): string {
    return text + " ".repeat(Math.max(1, width - visibleLen(text)));
  }

  private inputMaxText(): number {
    return this.usable < 22 ? this.usable - 2 : this.innerWidth() - 4;
  }

  private renderInput(): string {
    const maxText = this.inputMaxText();
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
    const maxVisible = Math.max(1, Math.min(this.rows - 10, items.length));
    const first = Math.max(0, Math.min(this.menuIndex - maxVisible + 1, items.length - maxVisible));
    const window = items.slice(first, first + maxVisible);
    const menuW = Math.min(this.innerWidth() - 6, 64);
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

  private centered(content: string): string {
    const budget = Math.max(4, this.innerWidth() - 4);
    const lead = Math.max(0, Math.floor((budget - visibleLen(content)) / 2));
    return " ".repeat(lead) + content;
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
      this.view === "help" ? this.helpLines
      : this.view === "picker" ? this.renderPicker()
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
      : this.view === "modelPick" ? this.modelPickLines()
      : [];
    const lines: string[] = [];
    let minimal = true;
    let bannerArt = false;
    let tight = false;
    if (this.rows >= 7 && this.usable >= 22) {
      minimal = false;
      const bannerOn = this.bannerActive && ((overlay.length === 0 && menu.length === 0) || this.rows >= 30);
      bannerArt = bannerOn && this.rows >= 14;
      tight = bannerArt && this.rows < 18;
      lines.push(this.boxEdge(true));
      if (!tight) lines.push(this.boxLine(""));
      if (bannerOn) {
        if (bannerArt) {
          for (const bannerLine of this.bannerInnerLines()) {
            lines.push(this.boxLine(this.centered(bannerLine)));
          }
        } else if (this.rows >= 8) {
          const brand = brandName();
          lines.push(this.boxLine(this.centered(C.teal + C.bold + "✦ " + brand + C.reset + C.dim + "  v" + this.bannerVersion + C.reset)));
        }
        if (this.rows >= 18) lines.push(this.boxLine(""));
      }
      const inner = Math.max(10, this.innerWidth() - 6);
      const footerLines = (this.rows >= 9 ? 1 : 0) + (this.rows >= 12 ? 1 : 0);
      const imageRows = this.imageFeed.reduce((n, block) => n + block.rows, 0);
      const fixedCount = lines.length + 5 + (this.workingLine ? 1 : 0) + menu.length + overlay.length;
      const budget = Math.max(1, this.rows - footerLines - fixedCount - imageRows);
      const visuals: string[] = [];
      for (let i = this.chatLines.length - 1; i >= 0 && visuals.length < budget; i--) {
        const wrapped = wrap(this.chatLines[i]!, inner);
        for (let j = wrapped.length - 1; j >= 0 && visuals.length < budget; j--) {
          visuals.unshift(wrapped[j]!);
        }
      }
      for (const visual of visuals) lines.push(this.boxLine("  " + visual));
      for (const block of this.imageFeed) {
        block.start = lines.length;
        lines.push(block.token);
        for (let pad = 1; pad < block.rows; pad++) lines.push("");
      }
      if (this.workingLine) lines.push(this.boxLine("  " + this.workingLine));
      for (const pending of this.pendingImages) {
        if (pending.preview.length === 0 && !pending.image) continue;
        lines.push(this.boxLine("  " + C.teal + "▤ " + C.reset + C.bold + pending.name + C.reset + C.dim + "  attached — sent with your next message" + C.reset));
        for (const row of pending.preview) lines.push(this.boxLine(row));
      }
      const contentBudget = Math.max(4, this.innerWidth() - 4);
      const blockLead = (block: string[]): string => {
        const wide = Math.max(0, ...block.map((l) => visibleLen(l)));
        return " ".repeat(Math.max(0, Math.floor((contentBudget - wide) / 2)));
      };
      if (overlay.length > 0) {
        const lead = blockLead(overlay);
        for (const overlayLine of overlay) lines.push(this.boxLine(lead + overlayLine));
      }
      if (menu.length > 0) {
        const lead = blockLead(menu);
        for (const menuLine of menu) lines.push(this.boxLine(lead + menuLine));
      }
      lines.push(this.boxLine(""));
      lines.push(C.dim + this.boxLead() + "├" + "─".repeat(this.innerWidth() + 2) + "┤" + C.reset);
      this.inputRow = lines.length;
      lines.push(this.boxLine(this.renderInput()));
      lines.push(this.boxLine(this.renderStatus()));
      lines.push(this.boxEdge(false));
    } else {
      const bannerRows = this.bannerActive && this.rows >= 7 ? (this.usable >= 14 ? 2 : 1) : 0;
      const chrome = 1 + (this.usable >= 16 && this.rows >= 5 ? 1 : 0);
      const chatBudget = Math.max(0, this.rows - bannerRows - chrome - menu.length - overlay.length - 1);
      if (this.bannerActive && bannerRows > 0) {
        if (this.usable >= 14) {
          lines.push(C.teal + C.bold + "✦ " + brandName() + C.reset + C.dim + "  v" + this.bannerVersion + C.reset);
          lines.push("");
        } else {
          lines.push(C.teal + C.bold + "✦ " + brandName() + C.reset);
        }
      }
      if (chatBudget > 0 && this.chatLines.length > 0) {
        const inner = Math.max(8, this.usable - 1);
        const visuals: string[] = [];
        for (let i = this.chatLines.length - 1; i >= 0 && visuals.length < chatBudget; i--) {
          const wrapped = wrap(this.chatLines[i]!, inner);
          for (let j = wrapped.length - 1; j >= 0 && visuals.length < chatBudget; j--) {
            visuals.unshift(wrapped[j]!);
          }
        }
        for (const visual of visuals) lines.push(plainClip(visual, this.usable - 1));
      }
      for (const flyLine of [...menu, ...overlay]) lines.push(flyLine);
      this.inputRow = lines.length;
      lines.push(this.bar() + this.renderInput());
      if (this.usable >= 16 && this.rows >= 5) lines.push(this.renderStatus());
    }
    const footerAllowed = this.usable >= 22 && !tight;
    if (this.rows >= 9 && footerAllowed) lines.push(this.renderHints());
    if (this.rows >= 12 && footerAllowed) lines.push(this.renderTip());
    const footer = ((this.rows >= 9 && footerAllowed) ? 1 : 0) + ((this.rows >= 12 && footerAllowed) ? 1 : 0);
    const pad = Math.max(0, this.rows - lines.length);
    if (pad > 0) {
      const body = lines.slice(0, lines.length - footer);
      const foot = lines.slice(lines.length - footer);
      const below = Math.floor(pad / 2);
      const above = pad - below;
      for (let i = 0; i < above; i++) body.unshift("");
      for (let i = 0; i < below; i++) body.push("");
      this.inputRow += above;
      return [...body, ...foot];
    }
    return lines;
  }

  private render(): void {
    const cols = this.tty.columns > 0 ? this.tty.columns : 80;
    const rowsNow = this.tty.rows > 0 ? this.tty.rows : 24;
    if (this.lastCols > 0 && (cols !== this.lastCols || rowsNow !== this.lastRows)) {
      this.tty.write("\x1b[2J\x1b[3J");
      this.lastLines = [];
    }
    this.lastCols = cols;
    this.lastRows = rowsNow;
    const frame = this.buildLines();
    let dropped = Math.max(0, frame.length - rowsNow);
    for (const block of this.imageFeed) {
      while (block.start >= 0 && block.start < dropped && dropped < block.start + block.rows) {
        dropped = block.start + block.rows;
      }
    }
    const budget = Math.max(8, cols - 1);
    const view = frame.slice(dropped).map((line) => (visibleLen(line) <= budget ? line : C.reset + plainClip(line, budget)));
    const inputRow = Math.max(0, Math.min(this.inputRow - dropped, view.length - 1));
    const cursorCol = Math.max(0, Math.min(this.cursorCol, cols - 1));
    const prev = this.lastLines;
    const parts: string[] = ["\x1b[H"];
    let fullDraw = true;
    if (prev.length > 0 && prev.length === view.length) {
      fullDraw = false;
      for (let i = 0; i < view.length; i++) {
        if (prev[i] === view[i]) continue;
        parts.push("\x1b[" + (i + 1) + "H\r\x1b[K" + view[i]!);
        const payload = this.inlinePayloadAt(view[i]!);
        if (payload) parts.push("\x1b[" + (i + 1) + ";4H" + payload);
      }
    } else {
      for (let i = 0; i < view.length; i++) {
        parts.push(view[i]! + "\x1b[K" + (i < view.length - 1 ? "\r\n" : ""));
      }
      parts.push("\x1b[J");
    }
    if (fullDraw && this.inlinePayloads.size > 0) {
      for (let i = 0; i < view.length; i++) {
        const payload = this.inlinePayloadAt(view[i]!);
        if (payload) parts.push("\x1b[" + (i + 1) + ";4H" + payload);
      }
    }
    parts.push("\x1b[" + (inputRow + 1) + ";" + (cursorCol + 1) + "H");
    this.tty.write(parts.join(""));
    this.lastLines = view;
    this.shown = true;
  }

  private inlinePayloadAt(line: string): string | null {
    for (const [token, payload] of this.inlinePayloads) {
      if (line.includes(token)) return payload;
    }
    return null;
  }

  historyImage(image: LoadedImage): void {
    try {
    const id = ++this.inlineSeq;
    const token = "\x00".repeat(6 + id);
    const support = this.options.imageSupport ?? imageSupport();
    if (support === "none") {
      for (const line of fallbackPanel(image, this.innerWidth()).replace(/\n$/, "").split("\n")) this.chatLines.push(line);
      this.chatStreamOpen = false;
      this.refresh();
      return;
    }
    const cols = Math.max(8, Math.min(22, Math.floor(this.innerWidth() / 4)));
    const rowCap = Math.max(4, Math.min(9, Math.floor(this.rows / 3)));
    let rows = 6;
    if (image.width !== null && image.height !== null && image.width > 0) {
      rows = Math.round((cols * image.height) / image.width);
    }
    const byHeight = rows > rowCap;
    if (byHeight) rows = rowCap;
    const payload = support === "iterm"
      ? itermImagePayload(image, byHeight ? rows : cols, byHeight)
      : kittyImagePayload(image, byHeight ? rows : cols, byHeight);
    this.inlinePayloads.set(token, payload);
    this.imageFeed.push({ token, rows, start: -1 });
    this.refresh();
    } catch (error) {
      this.notice("✘ inline image: " + (error instanceof Error ? error.message : String(error)));
    }
  }

  private cursorColumn(): number {
    const maxText = this.inputMaxText();
    if (this.usable < 22) return 2 + visibleLen(trunc(this.input.slice(0, this.cursor), maxText));
    const lead = this.boxLead().replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").length;
    return lead + 3 + visibleLen(trunc(this.input.slice(0, this.cursor), maxText));
  }

  refresh(): void {
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
  }

  hide(): void {
    if (!this.shown) return;
    this.tty.write("\x1b[H\x1b[2J");
    this.shown = false;
    this.lastLines = [];
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

  openModelPick(provider: string, models: string[], preferred?: string, role?: string): void {
    this.modelPickProvider = provider;
    this.modelPickList = models;
    this.modelPickIndex = preferred ? Math.max(0, models.indexOf(preferred)) : 0;
    this.modelPickOffset = 0;
    this.modelPickRole = role ?? "";
    if (models.length === 0) return;
    this.clampModelPickOffset();
    this.view = "modelPick";
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

  // refresh provider data in place — never steals focus from the chat prompt
  updateProviders(providers: ProviderEntry[]): void {
    this.providers = providers;
    if (this.openProvider) {
      this.openProvider = providers.find((p) => p.name === this.openProvider?.name) ?? null;
    }
    if (this.view === "providers" || this.view === "provider") this.refresh();
  }

  private clampModelPickOffset(): void {
    const window = 10;
    if (this.modelPickIndex < this.modelPickOffset) this.modelPickOffset = this.modelPickIndex;
    if (this.modelPickIndex >= this.modelPickOffset + window) {
      this.modelPickOffset = this.modelPickIndex - window + 1;
    }
  }

  private modelPickLines(): string[] {
    const body: string[] = [];
    const budget = Math.max(6, this.usable - 4);
    const window = 10;
    const start = this.modelPickOffset;
    const end = Math.min(this.modelPickList.length, start + window);
    body.push(C.dim + trunc("pick a model — it drives all tiers (change later in /model)", budget) + C.reset);
    for (let i = start; i < end; i++) {
      const active = i === this.modelPickIndex;
      const marker = active ? C.teal + "❯ " + C.reset : "  ";
      body.push(marker + (active ? C.cream + this.modelPickList[i]! + C.reset : this.modelPickList[i]!));
    }
    if (this.modelPickList.length > window) {
      body.push(C.dim + `${this.modelPickIndex + 1}/${this.modelPickList.length}` + C.reset);
    }
    body.push(C.dim + trunc("↑↓ move · enter select · esc keep current", budget) + C.reset);
    return body;
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
    const totalRows = Math.ceil(names.length / perRow);
    const maxListRows = Math.max(2, Math.min(totalRows, this.rows - 13));
    let firstRow = Math.max(0, Math.min(Math.floor(this.brandColorIndex / perRow) - 1, totalRows - maxListRows));
    const lastRow = Math.min(totalRows, firstRow + maxListRows);
    const cellWidth = Math.max(8, Math.min(14, Math.floor((this.nestedWidth() - 2) / perRow)));
    if (firstRow > 0) body.push(C.dim + "  ↑ more" + C.reset);
    for (let row = firstRow; row < lastRow; row += 1) {
      const cells: string[] = [];
      for (let col = 0; col < perRow; col++) {
        const index = row * perRow + col;
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
        const namePart = trunc(name, Math.max(2, cellWidth - 5));
        const cell = (sel ? C.teal + "❯ " + C.reset : "   ") + swatch + " " + (sel ? C.bold + C.teal + namePart : C.cream + namePart) + C.reset;
        cells.push(this.padCell(cell, cellWidth));
      }
      body.push(cells.join(""));
    }
    if (lastRow < totalRows) body.push(C.dim + "  ↓ more" + C.reset);
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
    return Math.max(4, Math.floor((this.nestedWidth() - 2) / 3));
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
    const maxRows = Math.max(3, Math.min(10, this.rows - 15));
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

  async onResizeAsync(): Promise<void> {
    this.onResize();
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }

  onResize(): void {
    if (this.resizeTimer !== null) return;
    this.resizeTimer = setTimeout(() => {
      this.resizeTimer = null;
      this.tty.write("\x1b[2J\x1b[3J");
      this.lastLines = [];
      this.shown = false;
      this.show();
    }, 0);
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

  private insert(ch: string, cap: number): void {
    if (visibleLen(this.input) >= cap) return;
    this.input = this.input.slice(0, this.cursor) + ch + this.input.slice(this.cursor);
    this.cursor += 1;
    this.menuIndex = 0;
    this.historyIndex = null;
    this.detectAttachments();
  }

  private insertPasteText(ch: string): void {
    if (ch === "\n") {
      if (this.pasteBreak) return;
      this.pasteBreak = true;
      this.insert(" ", PASTE_INPUT_CAP);
    } else {
      this.pasteBreak = false;
      this.insert(ch, PASTE_INPUT_CAP);
    }
    this.refresh();
  }

  private detectAttachments(): void {
    const located = locateImagePaths(this.input);
    for (const hit of located.reverse()) {
      if (this.pendingPaths.has(hit.path)) continue;
      if (!existsSync(hit.path)) {
        void this.recoverPastedImage(hit);
        continue;
      }
      if (this.pendingImages.length >= MAX_IMAGES) {
        this.pendingPaths.add(hit.path);
        this.notice("✘ " + hit.path + " — skipped, max " + MAX_IMAGES + " images per message");
        continue;
      }
      this.input = this.input.slice(0, hit.start) + this.input.slice(hit.end);
      this.cursor = Math.min(this.cursor, this.input.length);
      this.pendingPaths.add(hit.path);
      this.pendingImages.push({ path: hit.path, name: imageChipName(hit.path), image: null, preview: [] });
      void this.loadPending(hit.path);
    }
    if (located.length > 0) this.refresh();
  }

  private async loadPending(path: string): Promise<void> {
    const { images, errors } = await loadImagesFromPaths([path]);
    const entry = this.pendingImages.find((p) => p.path === path);
    if (entry && images[0]) {
      entry.image = images[0]!;
      const support = this.options.imageSupport ?? imageSupport();
      if (support === "none") {
        entry.preview = pixelPreviewLines(images[0]!, Math.min(64, Math.max(12, this.innerWidth() - 8)), Math.max(4, Math.min(16, this.rows - 8)));
        this.refresh();
      } else {
        entry.preview = [];
        this.historyImage(images[0]!);
      }
    } else if (entry && errors[0]) {
      this.pendingImages = this.pendingImages.filter((p) => p.path !== path);
      this.pendingPaths.delete(path);
      this.notice("✘ " + errors[0]!);
    }
  }

  private async recoverPastedImage(hit: LocatedImage): Promise<void> {
    if (!hit.path.includes("TemporaryItems")) return;
    if (this.recovering.has(hit.path) || this.pendingPaths.has(hit.path)) return;
    if (this.pendingImages.length >= MAX_IMAGES) {
      this.notice("✘ skipped — max " + MAX_IMAGES + " images per message");
      return;
    }
    this.recovering.add(hit.path);
    try {
      const save = this.options.clipboardSave ?? defaultClipboardSave;
      const saved = await save(join(cwd(), ".agent", "uploads"));
      const current = locateImagePaths(this.input).find((l) => l.path === hit.path);
      if (!current) return;
      if (!saved) {
        this.notice("✘ pasted image is gone and the clipboard holds no image — copy it again (Cmd+C), then paste here");
        return;
      }
      this.input = this.input.slice(0, current.start) + this.input.slice(current.end);
      this.cursor = Math.min(this.cursor, this.input.length);
      this.pendingPaths.add(saved);
      this.pendingImages.push({ path: saved, name: imageChipName(saved), image: null, preview: [] });
      await this.loadPending(saved);
    } finally {
      this.recovering.delete(hit.path);
    }
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
    const version = "v" + this.bannerVersion;
    if (!wide || !mini || this.innerWidth() < mini.width + 4) {
      return [C.teal + C.bold + "✦ " + brand + C.reset + C.dim + "  " + version + C.reset];
    }
    const useMini = this.innerWidth() < wide.width + 8;
    const art = useMini ? mini : wide;
    const gap = useMini ? " " : "  ";
    const lines: string[] = [];
    for (const cells of art.cells) {
      const colored = cells.map((cell, i) => colorForLetter(i, palette) + cell + C.reset).join(gap);
      lines.push(colored);
    }
    const meta = this.innerWidth() < 46
      ? version
      : version + " · your keys · your machine";
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

  showHelp(lines: string[]): void {
    this.helpLines = lines;
    this.view = "help";
    this.refresh();
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
    this.setTier(t);
    this.hooks.onTierChange(t);
    this.hooks.onTierModelPick(t.id);
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
    if (this.pasting) {
      if (key.kind === "paste-end") {
        this.pasting = false;
        return;
      }
      const text = key.kind === "char" ? key.ch : key.kind === "enter" || key.kind === "unknown" ? "\n" : null;
      if (text === null) return;
      if (this.view === "keyInput") {
        if (text !== "\n") {
          this.keyBuffer += text;
          this.refresh();
        }
        return;
      }
      if (this.view === "providerAdd") {
        const field = this.addFields[this.addFieldIndex];
        if (text !== "\n" && field !== undefined && field.length < 200) {
          this.addFields[this.addFieldIndex] = field + text;
          this.addError = "";
          this.refresh();
        }
        return;
      }
      this.insertPasteText(text);
      return;
    }
    if (key.kind === "paste-start") {
      this.pasting = true;
      this.pasteBreak = false;
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
    if (this.view === "help") {
      this.view = "prompt";
      this.helpLines = [];
      this.refresh();
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
        const wizard = this.wizardMode;
        if (wizard) {
          this.openProvider = null;
          this.exitWizard();
        } else {
          this.view = "provider";
          this.refresh();
        }
        if (name && keyValue) {
          if (wizard) this.hooks.onWizardKey(name, keyValue);
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
    if (this.view === "modelPick") {
      const count = this.modelPickList.length;
      if (count === 0) {
        this.view = "prompt";
        this.refresh();
        return;
      }
      if (key.kind === "up") {
        this.modelPickIndex = (this.modelPickIndex + count - 1) % count;
        this.clampModelPickOffset();
        this.refresh();
        return;
      }
      if (key.kind === "down") {
        this.modelPickIndex = (this.modelPickIndex + 1) % count;
        this.clampModelPickOffset();
        this.refresh();
        return;
      }
      if (key.kind === "enter") {
        const model = this.modelPickList[this.modelPickIndex]!;
        const name = this.modelPickProvider;
        const role = this.modelPickRole;
        this.view = "prompt";
        this.refresh();
        if (role) this.hooks.onBindModel(role, name + "/" + model);
        else this.hooks.onWizardModel(name, model);
        return;
      }
      if (key.kind === "escape") {
        this.view = "prompt";
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
        this.insert(key.ch, this.usable - 6);
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
