const NAME_RE = /^[A-Za-z]{2,12}$/;
export const DEFAULT_BRAND = "MIMON";

export function brandName(env: Record<string, string | undefined> = process.env): string {
  const raw = env["AGENT_NAME"] ?? "";
  return NAME_RE.test(raw) ? raw.toUpperCase() : DEFAULT_BRAND;
}

export const BRAND_PALETTE: Record<string, string> = {
  teal: "\x1b[38;5;37m",
  gold: "\x1b[38;5;214m",
  cream: "\x1b[38;5;223m",
  green: "\x1b[38;5;71m",
  red: "\x1b[38;5;167m",
  slate: "\x1b[38;5;103m",
  purple: "\x1b[38;5;141m",
  blue: "\x1b[38;5;75m",
  cyan: "\x1b[38;5;80m",
  orange: "\x1b[38;5;209m",
  pink: "\x1b[38;5;218m",
  white: "\x1b[38;5;255m",
  gray: "\x1b[38;5;245m",
  dark: "\x1b[38;5;235m",
};

export const DEFAULT_COLORS: string[] = ["teal", "gold"];

const HEX_RE = /^#?[0-9a-fA-F]{6}$/;

export function isHexColor(value: string): boolean {
  return HEX_RE.test(value);
}

export function validColorEntry(value: string): string | null {
  const lowered = value.trim().toLowerCase();
  if (BRAND_PALETTE[lowered]) return lowered;
  if (HEX_RE.test(lowered)) return "#" + lowered.replace("#", "").toLowerCase();
  return null;
}

export function validColorList(value: string[] | undefined): string[] | null {
  if (!value || value.length === 0 || value.length > 12) return null;
  const entries: string[] = [];
  for (const item of value) {
    const entry = validColorEntry(item);
    if (entry === null) return null;
    entries.push(entry);
  }
  return entries;
}

export function entryColor(entry: string): string {
  const named = BRAND_PALETTE[entry];
  if (named) return named;
  const hex = parseInt(entry.replace("#", ""), 16);
  if (Number.isNaN(hex)) return "\x1b[39m";
  const r = Math.floor(hex / 65536) % 256;
  const g = Math.floor(hex / 256) % 256;
  const b = hex % 256;
  return `\x1b[38;2;${r};${g};${b}m`;
}

export function brandColors(env: Record<string, string | undefined> = process.env): string[] {
  const raw = env["AGENT_COLORS"] ?? "";
  const codes = validColorList(raw.split(",").filter((part) => part.trim() !== ""))
    ?.map((entry) => entryColor(entry));
  if (codes && codes.length > 0) return codes;
  return DEFAULT_COLORS.map((name) => BRAND_PALETTE[name]!);
}

export function colorForLetter(index: number, colors: string[]): string {
  return colors[index % colors.length]!;
}


const XTERM16: Array<[number, number, number]> = [
  [0, 0, 0], [205, 0, 0], [0, 205, 0], [205, 205, 0],
  [0, 0, 238], [85, 85, 255], [205, 0, 205], [0, 205, 205],
  [229, 229, 229], [127, 127, 127], [255, 0, 0], [0, 255, 0],
  [255, 255, 0], [92, 92, 255], [255, 0, 255], [0, 255, 255],
];
const CUBE_LEVELS = [0, 95, 135, 175, 215, 255];

export function xterm256Hex(index: number): string {
  const i = Math.max(0, Math.min(255, Math.trunc(index)));
  let r: number; let g: number; let b: number;
  if (i < 16) {
    [r, g, b] = XTERM16[i]!;
  } else if (i < 232) {
    const n = i - 16;
    r = CUBE_LEVELS[Math.floor(n / 36)]!;
    g = CUBE_LEVELS[Math.floor(n / 6) % 6]!;
    b = CUBE_LEVELS[n % 6]!;
  } else {
    const v = 8 + (i - 232) * 10;
    r = v; g = v; b = v;
  }
  const toHex = (c: number) => c.toString(16).padStart(2, "0");
  return "#" + toHex(r) + toHex(g) + toHex(b);
}