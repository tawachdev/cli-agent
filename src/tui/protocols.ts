// Escape sequences for the two terminal image protocols we speak.
// iTerm2's OSC 1337 (also WezTerm, mintty) and kitty's APC graphics (also Ghostty).

const KITTY_CHUNK = 4096;

function decodedBytes(base64: string): number {
  const pad = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.floor((base64.length * 3) / 4) - pad;
}

// `stayPut` keeps the cursor where it was — the TUI paints pixels over cells of a
// frame it already drew; the scrollback renderer wants the cursor to move past it.
export function itermImage(base64: string, name: string, cols: number, rows: number, stayPut: boolean): string {
  return (
    "\x1b]1337;File=inline=1;preserveAspectRatio=1;" +
    (stayPut ? "doNotMoveCursor=1;" : "") +
    "size=" + decodedBytes(base64) +
    ";width=" + cols +
    ";height=" + rows +
    ";name=" + Buffer.from(name).toString("base64") +
    ":" + base64 +
    "\x07"
  );
}

function kittyChunks(firstControl: string, base64: string): string {
  if (base64.length === 0) return "\x1b_G" + firstControl + "m=0;\x1b\\";
  const chunks: string[] = [];
  for (let i = 0; i < base64.length; i += KITTY_CHUNK) {
    const more = i + KITTY_CHUNK < base64.length ? 1 : 0;
    const control = i === 0 ? firstControl : "q=2,";
    chunks.push("\x1b_G" + control + "m=" + more + ";" + base64.slice(i, i + KITTY_CHUNK) + "\x1b\\");
  }
  return chunks.join("");
}

// kitty sizes the box with `c`/`r` (cells). `w`/`h` would crop the source to that
// many *pixels* — which is how a whole screenshot used to shrink to a sliver.

// Transmit and display in one go, for the scrollback renderer.
export function kittyShow(png: string, cols: number, rows: number): string {
  return kittyChunks("f=100,a=T,q=2,c=" + cols + ",r=" + rows + ",", png);
}

// Upload the pixels once under an id; `kittyPlace` then shows them anywhere for a few bytes.
export function kittyTransmit(id: number, png: string): string {
  return kittyChunks("a=t,f=100,t=d,i=" + id + ",q=2,", png);
}

// Re-placing with the same placement id moves the image instead of duplicating it.
export function kittyPlace(id: number, placement: number, cols: number, rows: number): string {
  return "\x1b_Ga=p,i=" + id + ",p=" + placement + ",c=" + cols + ",r=" + rows + ",C=1,q=2\x1b\\";
}

// Lowercase `d=a`: remove every visible placement but keep the uploaded pixels.
export const KITTY_CLEAR_PLACEMENTS = "\x1b_Ga=d,d=a,q=2\x1b\\";

export function kittyFree(id: number): string {
  return "\x1b_Ga=d,d=I,i=" + id + ",q=2\x1b\\";
}
