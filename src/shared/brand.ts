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

export const DEFAULT_COLORS: [string, string] = ["teal", "gold"];

export function brandColors(env: Record<string, string | undefined> = process.env): [string, string] {
  const raw = env["AGENT_COLORS"] ?? "";
  const parts = raw.split(",").map((name) => name.trim().toLowerCase());
  if (parts.length === 2 && parts.every((name) => BRAND_PALETTE[name])) {
    return [BRAND_PALETTE[parts[0]!]!, BRAND_PALETTE[parts[1]!]!];
  }
  return [BRAND_PALETTE[DEFAULT_COLORS[0]!]!, BRAND_PALETTE[DEFAULT_COLORS[1]!]!];
}
