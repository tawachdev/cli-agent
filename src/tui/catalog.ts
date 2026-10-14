import { brandName } from "../shared/brand";
import { ANSI as C } from "../shared/tokens";

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

export const COMMANDS: SlashCommand[] = [
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

export function tipsList(): string[] {
  return [
    TIP_BASES[0]!,
    TIP_BASES[1]! + brandName() + " 1 · 2 · 3 · MAX instantly",
    TIP_BASES[2]!,
    TIP_BASES[3]!,
    TIP_BASES[4]!,
  ];
}
