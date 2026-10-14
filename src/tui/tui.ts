
import { brandColors, brandName, colorForLetter, } from "../shared/brand";
import { existsSync, } from "node:fs";
import { saveClipboardImage } from "./clipboard";
import { spawn } from "node:child_process";
import type { LoadedImage, } from "./images";
import { ImageLayer, type ImageLayerOptions, type Placement } from "./image-layer";
import { glyphWord } from "../shared/glyphs";
import { ANSI as C } from "../shared/tokens";
import { PRODUCT_VERSION } from "../shared/version";

import { COMMANDS, type MimonTier, type ProviderEntry, type SlashCommand, TIERS, tipsList } from "./catalog";
import type { Key } from "./keys";
import { type Attachment, type AttachmentHost, Attachments, looksLikeBase64Image } from "./attachments";
import { Transcript } from "./transcript";
import { BrandFlow } from "./views/brand";
import { ModelPick } from "./views/model-pick";
import { ProvidersFlow } from "./views/providers";
import type { Frame } from "./views/frame";
import { plainClip, trunc, type Tty, visibleLen, wrap } from "./term";

export { C };
export { PRODUCT_VERSION };
export { BIND_TARGETS, TIERS, type BindTarget, type MimonTier, type ProviderEntry, type SlashCommand } from "./catalog";
export { decodeChunk, type Key } from "./keys";
export { fit, plainClip, type Tty, visibleLen, WIDTH, wrap } from "./term";
export { chip, fmtSecs, meter, panel, splash } from "./widgets";

const PASTE_INPUT_CAP = 4096;
const TRAY_GAP = 2;
const TRAY_TILE_MIN_COLS = 6;
const TRAY_TILE_MAX_COLS = 20;
const TRANSCRIPT_IMAGE_COLS = 44;
const TRANSCRIPT_IMAGE_ROWS = 14;

function trayRowsFor(screenRows: number): number {
  if (screenRows >= 34) return 6;
  if (screenRows >= 26) return 5;
  if (screenRows >= 20) return 4;
  if (screenRows >= 16) return 3;
  return 0;
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

export interface TuiOptions extends ImageLayerOptions {
  clipboardSave?: (destDir: string) => Promise<string | null>;
  openImage?: (image: LoadedImage) => void;
}

const defaultClipboardSave = (destDir: string): Promise<string | null> => saveClipboardImage(destDir);

const defaultOpenImage = (image: LoadedImage): void => {
  const tool = process.platform === "darwin" ? "open" : process.platform === "linux" ? "xdg-open" : null;
  if (!tool || !existsSync(image.path)) return;
  try {
    const child = spawn(tool, [image.path], { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch {}
};

export class Tui {
  tier: MimonTier = TIERS[1]!;
  private input = "";
  private cursor = 0;
  private view: "prompt" | "picker" | "permission" | "providers" | "modelPick" | "brand" | "help" = "prompt";
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
  private statusExtra = "";
  private typeahead = "";
  private submitQueued = false;

  private readonly images: ImageLayer;
  private readonly brand: BrandFlow;
  private readonly attachments: Attachments;
  private readonly transcript: Transcript;
  private readonly providerViews: ProvidersFlow;
  private readonly modelPick: ModelPick;
  private framePlacements: Placement[] = [];
  private history: string[] = [];
  private workingLine = "";
  private helpLines: string[] = [];
  private bannerActive = false;
  private bannerVersion = "";
  private lastLines: string[] = [];
  private lastCols = 0;
  private lastRows = 0;
  private resizeTimer: ReturnType<typeof setTimeout> | null = null;
  private pasting = false;
  private pasteBreak = false;
  private pasteBuf = "";

  constructor(
    private readonly tty: Tty,
    private readonly hooks: TuiHooks,
    private readonly options: TuiOptions = {},
  ) {
    this.images = new ImageLayer(options);
    const tui = this;
    const frame: Frame = {
      get rows() {
        return tui.rows;
      },
      get usable() {
        return tui.usable;
      },
      innerWidth: () => this.innerWidth(),
      nestedWidth: () => this.nestedWidth(),
      boxed: (title, body) => this.boxed(title, body),
      refresh: () => this.refresh(),
      closeView: () => {
        this.view = "prompt";
      },
    };
    this.brand = new BrandFlow(frame, hooks);
    const prompt: AttachmentHost = {
      get input() {
        return tui.input;
      },
      set input(value: string) {
        tui.input = value;
      },
      get cursor() {
        return tui.cursor;
      },
      set cursor(value: number) {
        tui.cursor = value;
      },
      refresh: () => this.refresh(),
      notice: (message) => this.notice(message),
    };
    this.transcript = new Transcript(this.images, () => this.refresh());
    this.attachments = new Attachments(prompt, this.images, options.clipboardSave ?? defaultClipboardSave);
    this.providerViews = new ProvidersFlow(frame, hooks);
    this.modelPick = new ModelPick(frame, hooks);
  }

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

  nestedWidth(): number {
    return Math.max(12, this.innerWidth() - 8);
  }

  boxed(title: string, body: string[]): string[] {
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

  private inputMaxText(): number {
    return this.usable < 22 ? this.usable - 2 : this.innerWidth() - 4;
  }

  private renderInput(): string {
    const maxText = this.inputMaxText();
    if (this.busy) {
      return C.dim + trunc("▌ working — esc to stop", maxText) + C.reset;
    }
    if (this.input === "") {
      const hint = this.attachments.count > 0
        ? "Say what to do with " + (this.attachments.count > 1 ? "these images" : "this image") + "… enter sends · esc removes"
        : 'Ask anything… "fix the flaky test in auth"';
      return C.dim + trunc(hint, maxText) + C.reset;
    }
    const before = trunc(this.input.slice(0, this.cursor), maxText);
    const restBudget = Math.max(0, maxText - before.length);
    const after = trunc(this.input.slice(this.cursor), restBudget);
    return C.cream + before + C.reset + C.cream + after + C.reset;
  }

  private renderStatus(): string {
    const label = trunc(this.tier.label, Math.max(3, Math.min(9, this.innerWidth() - 3)));
    const images = this.attachments.count > 0 ? " · ▤" + this.attachments.count + " attached" : "";
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
      this.framePlacements = [];
      return lines;
    }
    const menu = this.view === "picker" ? [] : this.renderMenu();
    const overlay =
      this.view === "help" ? this.helpLines
      : this.view === "picker" ? this.renderPicker()
      : this.view === "providers" ? this.providerViews.lines()
      : this.view === "brand" ? this.brand.lines()
      : this.view === "modelPick" ? this.modelPick.lines()
      : [];
    const lines: string[] = [];
    const placements: Placement[] = [];
    this.framePlacements = placements;
    let bannerArt = false;
    let tight = false;
    if (this.rows >= 7 && this.usable >= 22) {
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
      const tray = this.trayBlock();
      const fixedCount = lines.length + 5 + (this.workingLine ? 1 : 0) + menu.length + overlay.length + tray.lines.length;
      const budget = Math.max(1, this.rows - footerLines - fixedCount);
      const contentCol = this.boxLead().length + 3;
      const imageCols = Math.max(8, Math.min(inner - 2, TRANSCRIPT_IMAGE_COLS));
      const imageRows = Math.max(3, Math.min(TRANSCRIPT_IMAGE_ROWS, Math.floor(this.rows * 0.4)));
      const visuals = this.transcript.rows(budget, inner, { cols: imageCols, rows: imageRows });
      for (const visual of visuals) {
        if (visual.place) placements.push({ ...visual.place, row: lines.length, col: contentCol + 2 + visual.place.col });
        lines.push(this.boxLine("  " + visual.text));
      }
      if (this.workingLine) lines.push(this.boxLine("  " + this.workingLine));
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
      tray.lines.forEach((trayLine, i) => {
        for (const place of tray.places) {
          if (place.line === i) placements.push({ ...place.placement, row: lines.length, col: contentCol + place.placement.col });
        }
        lines.push(this.boxLine(trayLine));
      });
      this.inputRow = lines.length;
      lines.push(this.boxLine(this.renderInput()));
      lines.push(this.boxLine(this.renderStatus()));
      lines.push(this.boxEdge(false));
    } else {
      const bannerRows = this.bannerActive && this.rows >= 7 ? (this.usable >= 14 ? 2 : 1) : 0;
      const chrome = 1 + (this.usable >= 16 && this.rows >= 5 ? 1 : 0);
      const trayChip = this.attachments.count > 0 ? 1 : 0;
      const chatBudget = Math.max(0, this.rows - bannerRows - chrome - menu.length - overlay.length - trayChip - 1);
      if (this.bannerActive && bannerRows > 0) {
        if (this.usable >= 14) {
          lines.push(C.teal + C.bold + "✦ " + brandName() + C.reset + C.dim + "  v" + this.bannerVersion + C.reset);
          lines.push("");
        } else {
          lines.push(C.teal + C.bold + "✦ " + brandName() + C.reset);
        }
      }
      if (chatBudget > 0 && !this.transcript.isEmpty) {
        const visuals = this.transcript.plainRows(chatBudget, Math.max(8, this.usable - 1));
        for (const visual of visuals) lines.push(plainClip(visual, this.usable - 1));
      }
      for (const flyLine of [...menu, ...overlay]) lines.push(flyLine);
      if (this.attachments.count > 0) {
        lines.push(C.teal + "▤ " + C.reset + plainClip(this.attachments.list.map((p) => p.name).join(" · "), Math.max(4, this.usable - 3)));
      }
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
      const above = pad;
      for (let i = 0; i < above; i++) body.unshift("");
      this.inputRow += above;
      for (const placement of placements) placement.row += above;
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
    const dropped = Math.max(0, frame.length - rowsNow);
    const budget = Math.max(8, cols - 1);
    const view = frame.slice(dropped).map((line) => (visibleLen(line) <= budget ? line : C.reset + plainClip(line, budget)));
    const inputRow = Math.max(0, Math.min(this.inputRow - dropped, view.length - 1));
    const cursorCol = Math.max(0, Math.min(this.cursorCol, cols - 1));
    const placements = this.framePlacements
      .map((p) => ({ ...p, row: p.row - dropped }))
      .filter((p) => p.row >= 0 && p.row + p.rows <= view.length && p.col + p.cols <= budget);
    const prev = this.lastLines;
    const parts: string[] = ["\x1b[H"];
    if (prev.length > 0 && prev.length === view.length && this.images.unchanged(placements)) {
      const rewritten = new Set<number>();
      for (let i = 0; i < view.length; i++) {
        if (prev[i] === view[i]) continue;
        parts.push("\x1b[" + (i + 1) + "H\r\x1b[K" + view[i]!);
        rewritten.add(i);
      }
      parts.push(this.images.paint(placements, rewritten));
    } else {
      parts.push(this.images.wipe());
      for (let i = 0; i < view.length; i++) {
        parts.push(view[i]! + "\x1b[K" + (i < view.length - 1 ? "\r\n" : ""));
      }
      parts.push("\x1b[J");
      parts.push(this.images.paint(placements));
    }
    parts.push("\x1b[" + (inputRow + 1) + ";" + (cursorCol + 1) + "H");
    this.tty.write(parts.join(""));
    this.lastLines = view;
    this.shown = true;
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
    this.tty.write(this.images.wipe() + "\x1b[H\x1b[2J");
    this.shown = false;
    this.lastLines = [];
  }

  dispose(): void {
    const out = this.images.dispose();
    if (out) this.tty.write(out);
  }

  notice(msg: string): void {
    this.transcript.push(C.dim + trunc(msg, Math.max(6, this.usable - 2)) + C.reset);
    this.refresh();
  }

  beginBusy(): void {
    this.busy = true;
    this.turns += 1;
    this.refresh();
  }

  endBusy(): void {
    this.busy = false;
    if (this.typeahead !== "") {
      const queued = this.typeahead;
      this.typeahead = "";
      for (const ch of queued) this.insertPasteText(ch);
    }
    const shouldSubmit = this.submitQueued;
    this.submitQueued = false;
    if (shouldSubmit) {
      const task = this.input.trim();
      if (task) {
        if (this.history[this.history.length - 1] !== task) this.history.push(task);
        this.historyIndex = null;
        this.input = "";
        this.cursor = 0;
        this.beginBusy();
        this.hooks.onSubmit(task);
        return;
      }
    }
    this.show();
  }

  openPicker(bindings?: Record<string, string>): void {
    if (bindings) this.bindings = bindings;
    this.view = "picker";
    this.pickerIndex = Math.max(0, TIERS.findIndex((t) => t.id === this.tier.id));
    this.refresh();
  }

  openModelPick(provider: string, models: string[], preferred?: string, role?: string): void {
    if (!this.modelPick.open(provider, models, preferred, role)) return;
    this.view = "modelPick";
    this.refresh();
  }

  openProviders(providers: ProviderEntry[]): void {
    this.providerViews.open(providers);
    this.view = "providers";
    this.refresh();
  }

  updateProviders(providers: ProviderEntry[]): void {
    this.providerViews.setProviders(providers);
    if (this.view === "providers" && this.providerViews.showsProviderData()) this.refresh();
  }

  openWizard(providers: ProviderEntry[]): void {
    this.providerViews.openWizard(providers);
    this.view = "providers";
    this.refresh();
  }

  openBrand(current: { name: string; colors: string[]; customColors?: string[] }): void {
    this.brand.open(current);
    this.view = "brand";
    this.refresh();
  }

  setChatStatus(state: string, steps: number): void {
    this.statusExtra = state === "IDLE" && steps === 0 ? "" : " · " + state + " · steps " + steps;
    this.refresh();
  }

  setBrandCustomColors(colors: string[]): void {
    this.brand.setCustomColors(colors);
    if (this.view === "brand" && this.brand.showsPalette()) this.refresh();
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
    this.attachments.detect();
  }

  private insertPasteText(ch: string): void {
    this.applyPasteChar(ch);
    this.refresh();
  }

  private applyPasteChar(ch: string): void {
    if (ch === "\n") {
      if (this.pasteBreak) return;
      this.pasteBreak = true;
      this.insert(" ", PASTE_INPUT_CAP);
    } else {
      this.pasteBreak = false;
      this.insert(ch, PASTE_INPUT_CAP);
    }
  }

  private commitPaste(): void {
    const text = this.pasteBuf;
    this.pasteBuf = "";
    if (text === "") {
      this.refresh();
      return;
    }
    if (this.view === "providers" && this.providerViews.paste(text)) return;
    if (looksLikeBase64Image(text)) {
      this.attachments.pasteFromClipboard();
      return;
    }
    for (const ch of text) this.applyPasteChar(ch);
    if (this.attachments.count > 0 && this.input.trim() === "") {
      this.input = "";
      this.cursor = 0;
    }
    this.refresh();
  }

  private trayBlock(): { lines: string[]; places: Array<{ line: number; placement: Omit<Placement, "row"> }> } {
    const count = this.attachments.count;
    if (count === 0) return { lines: [], places: [] };
    const budget = Math.max(4, this.innerWidth() - 4);
    const gap = " ".repeat(TRAY_GAP);
    const tileCols = Math.max(TRAY_TILE_MIN_COLS, Math.min(TRAY_TILE_MAX_COLS, Math.floor((budget - TRAY_GAP * (count - 1)) / count)));
    const maxRows = trayRowsFor(this.rows);
    const pad = (text: string, width: number): string => plainClip(text, width) + " ".repeat(Math.max(0, width - visibleLen(text)));
    const caption = (att: Attachment, width: number): string => C.teal + "▤ " + C.reset + C.cream + trunc(att.name, Math.max(1, width - 2)) + C.reset;
    if (maxRows === 0 || tileCols * count + TRAY_GAP * (count - 1) > budget) {
      return { lines: [this.attachments.list.map((att) => caption(att, 24)).join(gap)], places: [] };
    }
    const tiles = this.attachments.list.map((att) => ({ att, cells: this.images.cells(att.image, att.thumb, tileCols, maxRows) }));
    const height = Math.max(1, ...tiles.map((tile) => tile.cells.lines.length));
    const lines: string[] = [];
    for (let r = 0; r < height; r++) {
      lines.push(tiles.map((tile) => pad(tile.cells.lines[r] ?? "", tileCols)).join(gap));
    }
    lines.push(tiles.map((tile) => pad(caption(tile.att, tileCols), tileCols)).join(gap));
    const places = tiles.flatMap(({ att, cells }, i) => {
      if (!cells.box || !att.thumb) return [];
      const col = i * (tileCols + TRAY_GAP) + cells.box.col;
      return [{ line: cells.box.line, placement: { slot: "tray:" + att.path, thumb: att.thumb, name: att.name, col, cols: cells.box.cols, rows: cells.box.rows } }];
    });
    return { lines, places };
  }

  showImage(image: LoadedImage): void {
    this.transcript.addImage(image);
    this.refresh();
  }

  openInViewer(): void {
    const opener = this.options.openImage ?? defaultOpenImage;
    const staged = this.attachments.loaded();
    if (staged.length > 0) {
      for (const image of staged) opener(image);
      return;
    }
    const last = this.transcript.lastImage();
    if (last) opener(last);
  }

  showError(message: string): void {
    const width = Math.max(10, this.innerWidth() - 6);
    const wrapped = wrap(message.replace(/\s+/g, " ").trim(), width);
    wrapped.forEach((l, i) => {
      this.transcript.push(C.red + (i === 0 ? "✘ " : "  ") + l + C.reset);
    });
    this.refresh();
  }

  historyPush(line: string): void {
    this.transcript.push(line);
    this.refresh();
  }

  historyStream(text: string): void {
    this.transcript.stream(text);
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
    this.transcript.endStream();
  }

  historyReplaceLast(line: string): void {
    this.transcript.replaceLast(line);
    this.refresh();
  }

  showHelp(lines: string[]): void {
    this.helpLines = lines;
    this.view = "help";
    this.refresh();
  }

  releaseSentUploads(): void {
    this.attachments.releaseSent();
  }

  async settleAttachments(): Promise<void> {
    await this.attachments.settle();
  }

  takePendingImages(): LoadedImage[] {
    return this.attachments.take();
  }

  hasPendingImages(): boolean {
    return this.attachments.count > 0;
  }

  clearPendingImages(): void {
    this.attachments.clear();
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

  handleKey(key: Key): void {
    if (key.kind === "ctrl-c") {
      this.hooks.onExit();
      return;
    }
    if (this.pasting) {
      if (key.kind === "paste-end") {
        this.pasting = false;
        this.commitPaste();
        return;
      }
      const text = key.kind === "char" ? key.ch : key.kind === "enter" || key.kind === "unknown" ? "\n" : null;
      if (text === null) return;
      if (this.pasteBuf.length < 131072) this.pasteBuf += text;
      return;
    }
    if (key.kind === "paste-start") {
      this.pasting = true;
      this.pasteBreak = false;
      this.pasteBuf = "";
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
      if (key.kind === "escape") {
        this.typeahead = "";
        this.submitQueued = false;
        this.hooks.onAbort();
        return;
      }
      if (key.kind === "char") this.typeahead += key.ch;
      else if (key.kind === "backspace") this.typeahead = this.typeahead.slice(0, -1);
      else if (key.kind === "enter") this.submitQueued = true;
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
    if (this.view === "brand") {
      this.brand.handleKey(key);
      return;
    }
    if (this.view === "providers") {
      this.providerViews.handleKey(key);
      return;
    }
    if (this.view === "modelPick") {
      this.modelPick.handleKey(key);
      return;
    }
    this.handlePromptKey(key);
  }

  private handlePromptKey(key: Key): void {
    const menuOpen = this.input.startsWith("/") && this.filtered().length > 0;
    switch (key.kind) {
      case "char":
        this.insert(key.ch, PASTE_INPUT_CAP);
        break;
      case "backspace":
        if (this.cursor > 0) {
          this.input = this.input.slice(0, this.cursor - 1) + this.input.slice(this.cursor);
          this.cursor -= 1;
        } else if (this.input === "" && this.attachments.count > 0) {
          this.attachments.removeLast();
        }
        break;
      case "ctrl-o":
        this.openInViewer();
        return;
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
        if (this.attachments.count > 0) {
          this.attachments.clear();
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
