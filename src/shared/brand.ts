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

export function validColorList(value: string[] | undefined): string[] | null {
  if (!value || value.length === 0 || value.length > 12) return null;
  const lowered = value.map((name) => name.trim().toLowerCase());
  return lowered.every((name) => BRAND_PALETTE[name]) ? lowered : null;
}

export function brandColors(env: Record<string, string | undefined> = process.env): string[] {
  const raw = env["AGENT_COLORS"] ?? "";
  const codes = validColorList(raw.split(",").filter((part) => part.trim() !== ""))
    ?.map((name) => BRAND_PALETTE[name]!);
  if (codes && codes.length > 0) return codes;
  return DEFAULT_COLORS.map((name) => BRAND_PALETTE[name]!);
}

export function colorForLetter(index: number, colors: string[]): string {
  return colors[index % colors.length]!;
}
