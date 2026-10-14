export type Key =
  | { kind: "char"; ch: string }
  | { kind: "enter" | "backspace" | "delete" | "up" | "down" | "left" | "right" | "home" | "end" | "escape" | "tab" | "ctrl-c" | "ctrl-p" | "ctrl-o" | "unknown" | "paste-start" | "paste-end" };

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
    if (ch === "\x0f") { keys.push({ kind: "ctrl-o" }); i += 1; continue; }
    if (ch < " ") { keys.push({ kind: "unknown" }); i += 1; continue; }
    keys.push({ kind: "char", ch });
    i += 1;
  }
  return { keys, rest: "" };
}

export const ARROW_STEPS: Partial<Record<Key["kind"], { dx: number; dy: number }>> = {
  up: { dx: 0, dy: -1 },
  down: { dx: 0, dy: 1 },
  left: { dx: -1, dy: 0 },
  right: { dx: 1, dy: 0 },
};
