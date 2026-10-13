// Scrollback widgets for the one-shot (non-TUI) mode and the boot splash.
import { brandColors, brandName, colorForLetter } from "../shared/brand";
import { glyphWord } from "../shared/glyphs";
import { ANSI as C } from "../shared/tokens";
import { trunc, type Tty, WIDTH } from "./term";

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
