import { cwd } from "node:process";
import { join } from "node:path";
import { brandColors, brandName, colorForLetter, } from "../shared/brand";
import { existsSync, rmSync } from "node:fs";
import { saveClipboardImage } from "./clipboard";
import { spawn } from "node:child_process";
import { imageChipName, loadImagesFromPaths, locateImagePaths, MAX_IMAGES, type LoadedImage, type LocatedImage } from "./images";
import { ImageLayer, type ImageLayerOptions, type Placement } from "./image-layer";
import type { Thumb } from "./thumbs";
import { glyphWord } from "../shared/glyphs";
import { ANSI as C } from "../shared/tokens";
import { PRODUCT_VERSION } from "../shared/version";

import { BIND_TARGETS, COMMANDS, type MimonTier, type ProviderEntry, type SlashCommand, TIERS, tipsList } from "./catalog";
import type { Key } from "./keys";
import { BrandFlow } from "./views/brand";
import type { Frame } from "./views/frame";
import { plainClip, trunc, type Tty, visibleLen, wrap } from "./term";

export { C };
export { PRODUCT_VERSION };
export { BIND_TARGETS, TIERS, type BindTarget, type MimonTier, type ProviderEntry, type SlashCommand } from "./catalog";
export { decodeChunk, type Key } from "./keys";
export { fit, plainClip, type Tty, visibleLen, WIDTH, wrap } from "./term";
export { chip, fmtSecs, meter, panel, splash } from "./widgets";

const PASTE_INPUT_CAP = 4096;
// chat entries that stand for an image block rather than a line of text
const IMAGE_ENTRY = "\u0000image:";
// image boxes, in terminal cells
const TRAY_GAP = 2;
const TRAY_TILE_MIN_COLS = 6;
const TRAY_TILE_MAX_COLS = 20;
const TRANSCRIPT_IMAGE_COLS = 44;
const TRANSCRIPT_IMAGE_ROWS = 14;

// Thumbnail height in the composer tray; 0 means the screen is too short — names only.
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

interface Attachment {
  path: string;
  name: string;
  image: LoadedImage | null;
  thumb: Thumb | null;
  loading: Promise<void> | null;
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
  private view: "prompt" | "picker" | "permission" | "providers" | "provider" | "keyInput" | "bindTo" | "brand" | "providerAdd" | "modelPick" | "help" = "prompt";
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
  private statusExtra = "";
  private typeahead = "";
  private submitQueued = false;

  private addFields: [string, string, string] = ["", "", ""];
  private addFieldIndex = 0;
  private addError = "";
  private pendingImages: Attachment[] = [];
  private pendingPaths = new Set<string>();
  private recovering = new Set<string>();
  private ownedUploads = new Set<string>();
  private readonly images: ImageLayer;
  private readonly brand: BrandFlow;
  private chatImages = new Map<string, { image: LoadedImage; thumb: Thumb | null }>();
  private chatImageSeq = 0;
  private framePlacements: Placement[] = [];
  private attachJobs = new Set<Promise<void>>();
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
  private pasteBuf = "";
  private modelPickProvider = "";
  private modelPickList: string[] = [];
  private modelPickIndex = 0;
  private modelPickOffset = 0;
  private modelPickRole = "";


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
      nestedWidth: () => this.nestedWidth(),
      boxed: (title, body) => this.boxed(title, body),
      refresh: () => this.refresh(),
      closeView: () => {
        this.view = "prompt";
      },
    };
    this.brand = new BrandFlow(frame, hooks);
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
      const hint = this.pendingImages.length > 0
        ? "Say what to do with " + (this.pendingImages.length > 1 ? "these images" : "this image") + "… enter sends · esc removes"
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
    const images = this.pendingImages.length > 0 ? " · ▤" + this.pendingImages.length + " attached" : "";
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
      this.framePlacements = [];
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
      : this.view === "brand" ? this.brand.lines()
      : this.view === "providerAdd" ? this.providerAddLines()
      : this.view === "modelPick" ? this.modelPickLines()
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
      const visuals: Array<{ text: string; place?: Omit<Placement, "row"> }> = [];
      for (let i = this.chatLines.length - 1; i >= 0 && visuals.length < budget; i--) {
        const entry = this.chatLines[i]!;
        if (entry.startsWith(IMAGE_ENTRY)) {
          const id = entry.slice(IMAGE_ENTRY.length);
          const shown = this.chatImages.get(id);
          if (!shown) continue;
          let block = this.images.captioned(shown.image, shown.thumb, imageCols, imageRows);
          // never slice an image in half at the top edge — collapse it to its caption
          if (visuals.length + block.lines.length > budget) block = { lines: block.lines.slice(0, 1), box: null };
          for (let j = block.lines.length - 1; j >= 0 && visuals.length < budget; j--) {
            const box = block.box;
            visuals.unshift(box && j === box.line && shown.thumb
              ? { text: block.lines[j]!, place: { slot: "chat:" + id, thumb: shown.thumb, name: shown.image.name, col: contentCol + 2 + box.col, cols: box.cols, rows: box.rows } }
              : { text: block.lines[j]! });
          }
          continue;
        }
        const wrapped = wrap(entry, inner);
        for (let j = wrapped.length - 1; j >= 0 && visuals.length < budget; j--) {
          visuals.unshift({ text: wrapped[j]! });
        }
      }
      for (const visual of visuals) {
        if (visual.place) placements.push({ ...visual.place, row: lines.length });
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
      const trayChip = this.pendingImages.length > 0 ? 1 : 0;
      const chatBudget = Math.max(0, this.rows - bannerRows - chrome - menu.length - overlay.length - trayChip - 1);
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
          const entry = this.chatLines[i]!;
          if (entry.startsWith(IMAGE_ENTRY)) {
            const shown = this.chatImages.get(entry.slice(IMAGE_ENTRY.length));
            if (shown) visuals.unshift(C.teal + "▤ " + C.reset + shown.image.name);
            continue;
          }
          const wrapped = wrap(entry, inner);
          for (let j = wrapped.length - 1; j >= 0 && visuals.length < chatBudget; j--) {
            visuals.unshift(wrapped[j]!);
          }
        }
        for (const visual of visuals) lines.push(plainClip(visual, this.usable - 1));
      }
      for (const flyLine of [...menu, ...overlay]) lines.push(flyLine);
      if (this.pendingImages.length > 0) {
        lines.push(C.teal + "▤ " + C.reset + plainClip(this.pendingImages.map((p) => p.name).join(" · "), Math.max(4, this.usable - 3)));
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
    // only images whose whole box is on screen get drawn; the rest stay blank cells
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
      // an image moved or the frame was rebuilt: wipe stale pixels before drawing
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

  // Drop every image we handed the terminal; call before leaving the alt screen.
  dispose(): void {
    const out = this.images.dispose();
    if (out) this.tty.write(out);
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
    this.detectAttachments();
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

  private looksLikeBase64Image(text: string): boolean {
    const body = text.replace(/\s+/g, "");
    if (body.length < 500) return false;
    const dataUrl = /^data:image\/[a-z+.-]+;base64,/.test(body);
    if (dataUrl) return true;
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(body)) return false;
    return body.startsWith("iVBORw0KGgo") || body.startsWith("/9j/") || body.startsWith("R0lGODlh") || body.startsWith("UklGR");
  }

  private commitPaste(): void {
    const text = this.pasteBuf;
    this.pasteBuf = "";
    if (text === "") {
      this.refresh();
      return;
    }
    if (this.view === "keyInput") {
      this.keyBuffer += text.replace(/\n+/g, " ").slice(0, 200);
      this.refresh();
      return;
    }
    if (this.view === "providerAdd") {
      const field = this.addFields[this.addFieldIndex];
      if (field !== undefined) {
        this.addFields[this.addFieldIndex] = (field + text.replace(/\n+/g, " ")).slice(0, 200);
        this.addError = "";
      }
      this.refresh();
      return;
    }
    if (this.looksLikeBase64Image(text)) {
      this.track(this.attachClipboardImage());
      return;
    }
    for (const ch of text) this.applyPasteChar(ch);
    if (this.pendingImages.length > 0 && this.input.trim() === "") {
      this.input = "";
      this.cursor = 0;
    }
    this.refresh();
  }

  private async attachClipboardImage(): Promise<void> {
    if (this.pendingImages.length >= MAX_IMAGES) {
      this.notice("✘ skipped — max " + MAX_IMAGES + " images per message");
      return;
    }
    if (this.recovering.has("clipboard")) return;
    this.recovering.add("clipboard");
    try {
      const save = this.options.clipboardSave ?? defaultClipboardSave;
      const saved = await save(join(cwd(), ".agent", "uploads"));
      if (!saved) {
        this.notice("✘ pasted image could not be read — copy it again (Cmd+C), then paste here");
        return;
      }
      if (this.pendingPaths.has(saved)) return;
      this.pendingPaths.add(saved);
      this.pendingImages.push({ path: saved, name: imageChipName(saved), image: null, thumb: null, loading: null });
      await this.loadPending(saved);
    } finally {
      this.recovering.delete("clipboard");
    }
  }

  private detectAttachments(): void {
    const located = locateImagePaths(this.input);
    for (const hit of located.reverse()) {
      if (this.pendingPaths.has(hit.path)) continue;
      if (!existsSync(hit.path)) {
        this.track(this.recoverPastedImage(hit));
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
      this.pendingImages.push({ path: hit.path, name: imageChipName(hit.path), image: null, thumb: null, loading: null });
      void this.loadPending(hit.path);
    }
    // a path pasted on its own leaves only whitespace behind — give the prompt back
    if (located.length > 0 && this.pendingImages.length > 0 && this.input.trim() === "") {
      this.input = "";
      this.cursor = 0;
    }
    if (located.length > 0) this.refresh();
  }

  // The composer tray: attached images wait here, above the input, until the
  // message is sent — so the user can explain what the model should do with them.
  private trayBlock(): { lines: string[]; places: Array<{ line: number; placement: Omit<Placement, "row"> }> } {
    const count = this.pendingImages.length;
    if (count === 0) return { lines: [], places: [] };
    const budget = Math.max(4, this.innerWidth() - 4);
    const gap = " ".repeat(TRAY_GAP);
    const tileCols = Math.max(TRAY_TILE_MIN_COLS, Math.min(TRAY_TILE_MAX_COLS, Math.floor((budget - TRAY_GAP * (count - 1)) / count)));
    const maxRows = trayRowsFor(this.rows);
    const pad = (text: string, width: number): string => plainClip(text, width) + " ".repeat(Math.max(0, width - visibleLen(text)));
    const caption = (att: Attachment, width: number): string => C.teal + "▤ " + C.reset + C.cream + trunc(att.name, Math.max(1, width - 2)) + C.reset;
    if (maxRows === 0 || tileCols * count + TRAY_GAP * (count - 1) > budget) {
      return { lines: [this.pendingImages.map((att) => caption(att, 24)).join(gap)], places: [] };
    }
    const tiles = this.pendingImages.map((att) => ({ att, cells: this.images.cells(att.image, att.thumb, tileCols, maxRows) }));
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

  // Put a sent image into the transcript, right under the message that carried it.
  showImage(image: LoadedImage): void {
    const id = String(++this.chatImageSeq);
    const cached = this.images.thumbFor(image);
    const shown = { image, thumb: cached.ready };
    this.chatImages.set(id, shown);
    this.chatLines.push(IMAGE_ENTRY + id);
    this.chatStreamOpen = false;
    this.refresh();
    if (!shown.thumb) {
      void cached.promise.then((thumb) => {
        shown.thumb = thumb;
        this.refresh();
      });
    }
  }

  // ctrl+o: open the attached images (or the last one sent) in the system viewer.
  openInViewer(): void {
    const opener = this.options.openImage ?? defaultOpenImage;
    const staged = this.pendingImages.flatMap((p) => (p.image ? [p.image] : []));
    if (staged.length > 0) {
      for (const image of staged) opener(image);
      return;
    }
    const last = [...this.chatImages.values()].at(-1);
    if (last) opener(last.image);
  }

  private track(job: Promise<void>): void {
    this.attachJobs.add(job);
    void job.finally(() => this.attachJobs.delete(job));
  }

  // Enter can land while a drop or clipboard paste is still being read; wait for it
  // so the image goes out with the message instead of being silently dropped.
  async settleAttachments(): Promise<void> {
    await Promise.all([...this.attachJobs]);
    await Promise.all(this.pendingImages.map((p) => p.loading ?? Promise.resolve()));
  }

  private loadPending(path: string): Promise<void> {
    const job = (async () => {
      const { images, errors } = await loadImagesFromPaths([path]);
      const entry = this.pendingImages.find((p) => p.path === path);
      if (!entry) return;
      if (images[0]) {
        entry.image = images[0]!;
        const cached = this.images.thumbFor(entry.image);
        entry.thumb = cached.ready;
        this.refresh();
        if (!entry.thumb) {
          entry.thumb = await cached.promise;
          this.refresh();
        }
      } else if (errors[0]) {
        this.pendingImages = this.pendingImages.filter((p) => p.path !== path);
        this.pendingPaths.delete(path);
        this.notice("✘ " + errors[0]!);
      }
    })();
    const entry = this.pendingImages.find((p) => p.path === path);
    if (entry) entry.loading = job;
    return job;
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
      if (this.input.trim() === "") this.input = "";
      this.cursor = Math.min(this.cursor, this.input.length);
      this.pendingPaths.add(saved);
      this.ownedUploads.add(saved);
      this.pendingImages.push({ path: saved, name: imageChipName(saved), image: null, thumb: null, loading: null });
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

  releaseSentUploads(): void {
    for (const path of this.ownedUploads) {
      try {
        rmSync(path, { force: true });
      } catch {}
    }
    this.ownedUploads.clear();
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
      this.brand.handleKey(key);
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
      if (key.kind === "up") move(-1);
      else if (key.kind === "down") move(1);
      else if (key.kind === "enter") this.selectProviderItem();
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
        } else if (this.input === "" && this.pendingImages.length > 0) {
          const removed = this.pendingImages.pop()!;
          this.pendingPaths.delete(removed.path);
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
