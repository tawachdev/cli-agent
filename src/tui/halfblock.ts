import type { RgbaPixels } from "./png";

export type ColorDepth = "truecolor" | "256";
type Rgb = [number, number, number];

const MATTE: Rgb = [10, 10, 16];
const SAMPLES_PER_CELL = 24;

export function colorDepth(env: Record<string, string | undefined> = process.env): ColorDepth {
  const colorterm = (env["COLORTERM"] ?? "").toLowerCase();
  if (colorterm === "truecolor" || colorterm === "24bit") return "truecolor";
  const program = env["TERM_PROGRAM"] ?? "";
  if (program === "iTerm.app" || program === "WezTerm" || program === "vscode" || program === "ghostty") return "truecolor";
  return "256";
}

const XTERM16: Rgb[] = [
  [0, 0, 0], [205, 0, 0], [0, 205, 0], [205, 205, 0],
  [0, 0, 238], [85, 85, 255], [205, 0, 205], [0, 205, 205],
  [229, 229, 229], [127, 127, 127], [255, 0, 0], [0, 255, 0],
  [255, 255, 0], [92, 92, 255], [255, 0, 255], [0, 255, 255],
];
const CUBE_STEPS = [0, 95, 135, 175, 215, 255];
const PALETTE256: Rgb[] = Array.from({ length: 256 }, (_v, i): Rgb => {
  if (i < 16) return XTERM16[i]!;
  if (i < 232) {
    const n = i - 16;
    return [CUBE_STEPS[Math.floor(n / 36)]!, CUBE_STEPS[Math.floor(n / 6) % 6]!, CUBE_STEPS[n % 6]!];
  }
  const v = 8 + (i - 232) * 10;
  return [v, v, v];
});

const channel = (v: number): number => Math.max(0, Math.min(255, Math.round(v)));

function nearestPaletteIndex(color: Rgb): number {
  const [r, g, b] = color.map(channel) as Rgb;
  let best = 16;
  let bestDist = Infinity;
  for (let i = 0; i < 256; i++) {
    const p = PALETTE256[i]!;
    const dist = (r - p[0]) ** 2 + (g - p[1]) ** 2 + (b - p[2]) ** 2;
    if (dist < bestDist) {
      bestDist = dist;
      best = i;
    }
  }
  return best;
}

function sampleGrid(pixels: RgbaPixels, cols: number, gridRows: number): Rgb[] {
  const grid: Rgb[] = [];
  for (let gy = 0; gy < gridRows; gy++) {
    for (let cx = 0; cx < cols; cx++) {
      const x0 = Math.floor((cx * pixels.width) / cols);
      const y0 = Math.floor((gy * pixels.height) / gridRows);
      const x1 = Math.min(pixels.width, Math.max(x0 + 1, Math.ceil(((cx + 1) * pixels.width) / cols)));
      const y1 = Math.min(pixels.height, Math.max(y0 + 1, Math.ceil(((gy + 1) * pixels.height) / gridRows)));
      const stride = Math.max(1, Math.floor(Math.max(x1 - x0, y1 - y0) / SAMPLES_PER_CELL));
      const sum: Rgb = [0, 0, 0];
      let n = 0;
      for (let y = y0; y < y1; y += stride) {
        for (let x = x0; x < x1; x += stride) {
          const o = (y * pixels.width + x) * 4;
          const a = pixels.data[o + 3]! / 255;
          for (let c = 0; c < 3; c++) sum[c] = sum[c]! + pixels.data[o + c]! * a + MATTE[c]! * (1 - a);
          n += 1;
        }
      }
      grid.push(n === 0 ? [...MATTE] : [sum[0] / n, sum[1] / n, sum[2] / n]);
    }
  }
  return grid;
}

function dither256(grid: Rgb[], cols: number, gridRows: number): number[] {
  const indices: number[] = [];
  const spread = (x: number, y: number, error: Rgb, share: number): void => {
    if (x < 0 || x >= cols || y >= gridRows) return;
    const target = grid[y * cols + x]!;
    for (let c = 0; c < 3; c++) target[c] = target[c]! + error[c]! * share;
  };
  for (let gy = 0; gy < gridRows; gy++) {
    for (let cx = 0; cx < cols; cx++) {
      const me = grid[gy * cols + cx]!;
      const pick = nearestPaletteIndex(me);
      indices.push(pick);
      const p = PALETTE256[pick]!;
      const error: Rgb = [me[0] - p[0], me[1] - p[1], me[2] - p[2]];
      spread(cx + 1, gy, error, 7 / 16);
      spread(cx - 1, gy + 1, error, 3 / 16);
      spread(cx, gy + 1, error, 5 / 16);
      spread(cx + 1, gy + 1, error, 1 / 16);
    }
  }
  return indices;
}

export function halfBlockLines(pixels: RgbaPixels, cols: number, rows: number, depth: ColorDepth = "256"): string[] {
  const gridRows = rows * 2;
  const grid = sampleGrid(pixels, cols, gridRows);
  const rgb = (c: Rgb): string => channel(c[0]) + ";" + channel(c[1]) + ";" + channel(c[2]);
  const indices = depth === "256" ? dither256(grid, cols, gridRows) : [];
  const cell = (top: number, bottom: number): string =>
    depth === "truecolor"
      ? "\x1b[38;2;" + rgb(grid[top]!) + ";48;2;" + rgb(grid[bottom]!) + "m▀"
      : "\x1b[38;5;" + indices[top]! + ";48;5;" + indices[bottom]! + "m▀";
  const lines: string[] = [];
  for (let ry = 0; ry < rows; ry++) {
    let line = "";
    for (let cx = 0; cx < cols; cx++) line += cell(ry * 2 * cols + cx, (ry * 2 + 1) * cols + cx);
    lines.push(line + "\x1b[0m");
  }
  return lines;
}
