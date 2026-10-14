import { BRAND_PALETTE, entryColor, validColorEntry, xterm256Hex } from "../../shared/brand";
import { ANSI as C } from "../../shared/tokens";
import { ARROW_STEPS, type Key } from "../keys";
import { padCell, trunc } from "../term";
import type { Frame } from "./frame";

export interface BrandHooks {
  onBrandName(name: string): void;
  onBrandColors(colors: string[]): void;
  onBrandReset(): void;
}

type Step = "menu" | "name" | "colorMode" | "colors" | "hex" | "grid";

const MENU = ["change name", "change colors", "reset to defaults"];
const COLOR_MODES = ["one color for the whole name", "a color for each letter"];
const CUSTOM_HEX = "custom hex…";
const ALL_256 = "all 256 colors…";
const PALETTE_PER_ROW = 2;

export class BrandFlow {
  private step: Step = "menu";
  private current: { name: string; colors: string[] } | null = null;
  private customColors: string[] = [];
  private menuIndex = 0;
  private modeIndex = 0;
  private nameBuffer = "";
  private nameError = "";
  private singleColor = false;
  private picks: string[] = [];
  private colorIndex = 0;
  private hexBuffer = "";
  private hexError = "";
  private gridIndex = 0;

  constructor(
    private readonly frame: Frame,
    private readonly hooks: BrandHooks,
  ) {}

  open(current: { name: string; colors: string[]; customColors?: string[] }): void {
    this.customColors = current.customColors ?? [];
    this.current = { name: current.name, colors: current.colors };
    this.nameError = "";
    this.picks = [];
    this.menuIndex = 0;
    this.step = "menu";
  }

  setCustomColors(colors: string[]): void {
    this.customColors = colors;
  }

  showsPalette(): boolean {
    return this.step === "colors";
  }

  lines(): string[] {
    switch (this.step) {
      case "menu":
        return this.menuLines();
      case "name":
        return this.nameLines();
      case "colorMode":
        return this.colorModeLines();
      case "colors":
        return this.colorsLines();
      case "hex":
        return this.hexLines();
      case "grid":
        return this.gridLines();
    }
  }

  handleKey(key: Key): void {
    const handlers: Record<Step, (key: Key) => void> = {
      menu: (k) => this.menuKey(k),
      name: (k) => this.nameKey(k),
      colorMode: (k) => this.colorModeKey(k),
      colors: (k) => this.colorsKey(k),
      hex: (k) => this.hexKey(k),
      grid: (k) => this.gridKey(k),
    };
    handlers[this.step](key);
  }

  private go(step: Step): void {
    this.step = step;
    this.frame.refresh();
  }

  private close(): void {
    this.step = "menu";
    this.frame.closeView();
    this.frame.refresh();
  }

  private hint(text: string): string {
    return C.dim + trunc(text, Math.max(6, this.frame.usable - 6)) + C.reset;
  }

  private error(text: string): string {
    return C.red + trunc(text, this.frame.usable - 6) + C.reset;
  }

  private choiceLines(items: string[], selected: number): string[] {
    return items.map((item, i) => {
      const sel = i === selected;
      const cursorCell = sel ? C.teal + "❯ " + C.reset : "  ";
      return cursorCell + (sel ? C.bold + C.teal + item + C.reset : C.bold + C.cream + item + C.reset);
    });
  }

  private lettersTotal(): number {
    return this.singleColor ? 1 : this.current?.name.length ?? 1;
  }

  private stageText(): string {
    if (this.singleColor) return "one color for the whole name";
    const letter = this.current?.name[this.picks.length] ?? "?";
    return "picking for letter " + letter + " (" + (this.picks.length + 1) + "/" + this.lettersTotal() + ")";
  }

  private menuLines(): string[] {
    const title = this.current
      ? "make it yours · " + this.current.name + " · " + this.current.colors.join(" + ")
      : "── make it yours ──";
    return this.frame.boxed(title, [...this.choiceLines(MENU, this.menuIndex), this.hint("↑↓ move · enter select · esc close")]);
  }

  private menuKey(key: Key): void {
    if (key.kind === "up" || key.kind === "down") {
      this.menuIndex = (this.menuIndex + (key.kind === "up" ? MENU.length - 1 : 1)) % MENU.length;
      this.frame.refresh();
    } else if (key.kind === "escape") {
      this.close();
    } else if (key.kind === "enter") {
      if (this.menuIndex === 0) {
        this.nameBuffer = "";
        this.nameError = "";
        this.go("name");
      } else if (this.menuIndex === 1) {
        this.modeIndex = 0;
        this.go("colorMode");
      } else {
        this.close();
        this.hooks.onBrandReset();
      }
    }
  }

  private nameLines(): string[] {
    const body = [C.bold + "New name:" + C.reset + " " + C.cream + this.nameBuffer + C.reset + C.inverse + " " + C.reset];
    if (this.nameError) body.push(this.error(this.nameError));
    body.push(this.hint("2-12 letters · enter save · esc back"));
    return this.frame.boxed("brand name", body);
  }

  private nameKey(key: Key): void {
    if (key.kind === "char" && this.nameBuffer.length < 12) {
      this.nameBuffer += key.ch;
      this.nameError = "";
      this.frame.refresh();
    } else if (key.kind === "backspace") {
      this.nameBuffer = this.nameBuffer.slice(0, -1);
      this.frame.refresh();
    } else if (key.kind === "enter") {
      if (!/^[A-Za-z]{2,12}$/.test(this.nameBuffer)) {
        this.nameError = "name must be 2-12 letters";
        this.frame.refresh();
        return;
      }
      const name = this.nameBuffer.toUpperCase();
      this.nameBuffer = "";
      this.nameError = "";
      this.close();
      this.hooks.onBrandName(name);
    } else if (key.kind === "escape") {
      this.nameBuffer = "";
      this.nameError = "";
      this.go("menu");
    }
  }

  private colorModeLines(): string[] {
    return this.frame.boxed("brand colors", [...this.choiceLines(COLOR_MODES, this.modeIndex), this.hint("↑↓ move · enter select · esc back")]);
  }

  private colorModeKey(key: Key): void {
    if (key.kind === "up" || key.kind === "down") {
      this.modeIndex = (this.modeIndex + 1) % COLOR_MODES.length;
      this.frame.refresh();
    } else if (key.kind === "enter") {
      this.singleColor = this.modeIndex === 0;
      this.picks = [];
      this.colorIndex = 0;
      this.go("colors");
    } else if (key.kind === "escape") {
      this.go("menu");
    }
  }

  private paletteEntries(): string[] {
    return [...Object.keys(BRAND_PALETTE), ...this.customColors, CUSTOM_HEX, ALL_256];
  }

  private swatch(name: string): string {
    if (name === CUSTOM_HEX) return "\x1b[38;5;80m" + "＃" + C.reset;
    if (name === ALL_256) return "\x1b[38;5;220m" + "▤" + C.reset;
    if (this.customColors.includes(name)) return entryColor(name) + "██" + C.reset;
    return BRAND_PALETTE[name] + "██" + C.reset;
  }

  private colorsLines(): string[] {
    const names = this.paletteEntries();
    const preview = (this.current?.name ?? "")
      .split("")
      .map((ch, i) => (i < this.picks.length ? entryColor(this.picks[i]!) + C.bold + ch + C.reset : C.dim + ch + C.reset))
      .join(" ");
    const body: string[] = [C.bold + "preview:" + C.reset + "  " + preview, ""];
    const totalRows = Math.ceil(names.length / PALETTE_PER_ROW);
    const maxListRows = Math.max(2, Math.min(totalRows, this.frame.rows - 13));
    const firstRow = Math.max(0, Math.min(Math.floor(this.colorIndex / PALETTE_PER_ROW) - 1, totalRows - maxListRows));
    const lastRow = Math.min(totalRows, firstRow + maxListRows);
    const cellWidth = Math.max(8, Math.min(14, Math.floor((this.frame.nestedWidth() - 2) / PALETTE_PER_ROW)));
    if (firstRow > 0) body.push(C.dim + "  ↑ more" + C.reset);
    for (let row = firstRow; row < lastRow; row += 1) {
      const cells: string[] = [];
      for (let col = 0; col < PALETTE_PER_ROW; col++) {
        const index = row * PALETTE_PER_ROW + col;
        if (index >= names.length) break;
        const name = names[index]!;
        const sel = index === this.colorIndex;
        const namePart = trunc(name, Math.max(2, cellWidth - 5));
        const cell = (sel ? C.teal + "❯ " + C.reset : "   ") + this.swatch(name) + " " + (sel ? C.bold + C.teal + namePart : C.cream + namePart) + C.reset;
        cells.push(padCell(cell, cellWidth));
      }
      body.push(cells.join(""));
    }
    if (lastRow < totalRows) body.push(C.dim + "  ↓ more" + C.reset);
    body.push(this.hint(this.stageText() + " · enter pick · esc undo"));
    return this.frame.boxed("brand colors", body);
  }

  private colorsKey(key: Key): void {
    const names = this.paletteEntries();
    const step = ARROW_STEPS[key.kind];
    if (step !== undefined) {
      this.colorIndex = (this.colorIndex + step.dx + step.dy * PALETTE_PER_ROW + names.length) % names.length;
      this.frame.refresh();
    } else if (key.kind === "enter") {
      const picked = names[this.colorIndex]!;
      if (picked === CUSTOM_HEX) {
        this.hexBuffer = "";
        this.hexError = "";
        this.go("hex");
      } else if (picked === ALL_256) {
        this.gridIndex = 16;
        this.go("grid");
      } else {
        this.pick(picked);
      }
    } else if (key.kind === "escape") {
      if (this.picks.length > 0) {
        this.picks.pop();
        this.frame.refresh();
      } else {
        this.go("menu");
      }
    }
  }

  private pick(entry: string): void {
    this.step = "colors";
    this.picks.push(entry);
    if (this.picks.length >= this.lettersTotal()) {
      const picks = this.picks;
      this.picks = [];
      this.close();
      this.hooks.onBrandColors(picks);
      return;
    }
    this.colorIndex = 0;
    this.frame.refresh();
  }

  private hexLines(): string[] {
    const entry = validColorEntry(this.hexBuffer);
    const swatch = entry ? entryColor(entry) + "██" + C.reset : C.dim + "██" + C.reset;
    const body = [C.bold + "Hex color:" + C.reset + " " + C.cream + this.hexBuffer + C.reset + C.inverse + " " + C.reset + "  " + swatch];
    if (this.hexError) body.push(this.error(this.hexError));
    body.push(this.hint("#rrggbb — e.g. #7c3aed · enter apply · esc back"));
    return this.frame.boxed("custom color", body);
  }

  private hexKey(key: Key): void {
    if (key.kind === "char" && this.hexBuffer.length < 9) {
      this.hexBuffer += key.ch;
      this.hexError = "";
      this.frame.refresh();
    } else if (key.kind === "backspace") {
      this.hexBuffer = this.hexBuffer.slice(0, -1);
      this.frame.refresh();
    } else if (key.kind === "enter") {
      const entry = validColorEntry(this.hexBuffer);
      if (!entry) {
        this.hexError = "use #rrggbb — six hex digits";
        this.frame.refresh();
        return;
      }
      this.hexBuffer = "";
      this.hexError = "";
      this.pick(entry);
    } else if (key.kind === "escape") {
      this.hexBuffer = "";
      this.hexError = "";
      this.go("colors");
    }
  }

  private gridPerRow(): number {
    return Math.max(4, Math.floor((this.frame.nestedWidth() - 2) / 3));
  }

  private gridLines(): string[] {
    const picked = xterm256Hex(this.gridIndex);
    const body: string[] = [C.bold + "preview:" + C.reset + "  " + entryColor(picked) + "████████" + C.reset + "  " + C.dim + picked + C.reset, ""];
    const perRow = this.gridPerRow();
    const maxRows = Math.max(3, Math.min(10, this.frame.rows - 15));
    const totalRows = Math.ceil(256 / perRow);
    const firstRow = Math.max(0, Math.min(Math.floor(this.gridIndex / perRow) - Math.floor(maxRows / 2), totalRows - maxRows));
    const lastRow = Math.min(totalRows, firstRow + maxRows);
    if (firstRow > 0) body.push(C.dim + "  ↑ more" + C.reset);
    for (let row = firstRow; row < lastRow; row++) {
      const cells: string[] = [];
      for (let col = 0; col < perRow; col++) {
        const index = row * perRow + col;
        if (index >= 256) break;
        const marker = index === this.gridIndex ? C.teal + "❯" + C.reset : " ";
        cells.push(marker + "\x1b[38;5;" + index + "m██" + C.reset);
      }
      body.push(cells.join(""));
    }
    if (lastRow < totalRows) body.push(C.dim + "  ↓ more" + C.reset);
    body.push(this.hint(this.stageText() + " · ↑↓←→ move · enter pick · esc back"));
    return this.frame.boxed("all 256 colors", body);
  }

  private gridKey(key: Key): void {
    const step = ARROW_STEPS[key.kind];
    if (step !== undefined) {
      this.gridIndex = Math.max(0, Math.min(255, this.gridIndex + step.dx + step.dy * this.gridPerRow()));
      this.frame.refresh();
    } else if (key.kind === "enter") {
      this.pick(xterm256Hex(this.gridIndex));
    } else if (key.kind === "escape") {
      this.go("colors");
    }
  }
}
