export interface DemoLine {
  kind: "cmd" | "out";
  text: string;
  cls?: string;
  gap?: number;
  stream?: boolean;
  chip?: "allow";
}

export const DEMO_LINES: DemoLine[] = [
  { kind: "out", text: "engine ready · 127.0.0.1:7800 · tier fast → glm-4.6", cls: "text-teal", gap: 240 },
  { kind: "out", text: "", gap: 80 },
  { kind: "cmd", text: "fix the failing test in src/tui", gap: 520 },
  { kind: "out", text: "● reading src/tui/chat.ts · 444 lines", cls: "text-slate", gap: 420 },
  { kind: "out", text: "⚠ edit src/tui/chat.ts", cls: "text-gold", gap: 260 },
  { kind: "out", text: '  <span class="text-red">- if (chunks.length) return null</span>', gap: 200 },
  { kind: "out", text: '  <span class="text-green">+ if (!chunks.length) return null</span>', gap: 280 },
  {
    kind: "out",
    text: "  allow [a] · edit [e] · deny [n]",
    cls: "text-fog",
    gap: 440,
    chip: "allow",
  },
  { kind: "out", text: "✓ patched · 1 hunk", cls: "text-green", gap: 320 },
  { kind: "out", text: "● exec bun test src/tui", cls: "text-slate", gap: 500 },
  { kind: "out", text: "✓ 42 pass · 0 fail · 312 ms", cls: "text-green", gap: 360 },
  { kind: "out", text: "fixed: the guard was inverted — valid chunks were rejected as empty.", cls: "text-cream", gap: 640 },
  { kind: "out", text: "", gap: 120 },
  { kind: "cmd", text: "what does ~/shots/error.png show?", gap: 420 },
  { kind: "out", text: "▤ error.png · 1280×800 · 214 KB · attached", cls: "text-fog", gap: 460 },
  {
    kind: "out",
    text: "Focus dies with the dialog: esc closes it but the caret never returns to the input, so the next keystrokes go nowhere until you click back.",
    cls: "text-cream",
    stream: true,
    gap: 0,
  },
];
