// Terminal text primitives: the output surface, and measuring, clipping and
// wrapping text by display cells rather than UTF-16 units.
import { stdout } from "node:process";
import { ANSI as C } from "../shared/tokens";

export interface Tty {
  write(data: string): void;
  readonly columns: number;
  readonly rows: number;
}

const WIDE_CHAR = /[\u1100-\u115F\u2329\u232A\u2E80-\u303E\u3041-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA000-\uA4CF\uA960-\uA97F\uAC00-\uD7A3\uF900-\uFAFF\uFE10-\uFE19\uFE30-\uFE6F\uFF01-\uFF60\uFFE0-\uFFE6\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F7E0}-\u{1F7EB}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FAFF}\u{20000}-\u{2FFFD}\u{30000}-\u{3FFFD}]/u;
// biome-ignore lint/suspicious/noMisleadingCharacterClass: tested one code point at a time, so the joiners are meant to match alone
const ZERO_WIDTH = /[\p{M}\u200B\u200C\u200D\u2060\uFEFF\x00]/u;

export function charWidth(ch: string): number {
  if (ZERO_WIDTH.test(ch)) return 0;
  if (WIDE_CHAR.test(ch)) return 2;
  return 1;
}

export function visibleLen(s: string): number {
  let n = 0;
  for (const ch of s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")) n += charWidth(ch);
  return n;
}

export function plainClip(s: string, max: number): string {
  let out = "";
  let n = 0;
  let i = 0;
  let sawEscape = false;
  while (i < s.length) {
    if (s[i] === "\x1b") {
      const m = /^\x1b\[[0-9;?]*[A-Za-z]/.exec(s.slice(i));
      if (m) {
        out += m[0];
        sawEscape = true;
        i += m[0].length;
        continue;
      }
    }
    const code = s.codePointAt(i)!;
    const ch = String.fromCodePoint(code);
    const w = charWidth(ch);
    if (n + w > max) break;
    out += ch;
    n += w;
    i += ch.length;
  }
  return sawEscape ? out + C.reset : out;
}

export function WIDTH(): number {
  const cols = stdout.columns;
  if (!cols || cols < 20) return 44;
  return Math.min(cols - 2, 92);
}

export function fit(s: string): string {
  const max = Math.max(20, stdout.columns || 44) - 1;
  const plain = s.replace(/\x1b\[[0-9;]*m/g, "");
  if (plain.length <= max) return s;
  return plain.slice(0, max);
}

export function wrap(text: string, width: number): string[] {
  const out: string[] = [];
  for (const rawLine of text.split("\n")) {
    let line = "";
    for (const word of rawLine.replace(/\s+/g, " ").trim().split(" ")) {
      if ((line + " " + word).trim().length > width) {
        if (line) out.push(line);
        line = word;
      } else {
        line = (line + " " + word).trim();
      }
    }
    out.push(line);
  }
  return out;
}

export function trunc(s: string, max: number): string {
  let out = "";
  let n = 0;
  for (const ch of s) {
    const w = charWidth(ch);
    if (n + w > max) break;
    out += ch;
    n += w;
  }
  return out;
}


// Pads to `width` cells, always leaving at least one space after the text.
export function padCell(text: string, width: number): string {
  return text + " ".repeat(Math.max(1, width - visibleLen(text)));
}
