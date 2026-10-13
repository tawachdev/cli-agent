// Everything the TUI needs to show images: shared thumbnails, half-block art for
// plain terminals, and the bookkeeping that keeps iTerm/kitty pixels in sync with
// a frame that is repainted by diffing text rows.
import { ANSI as C } from "../shared/tokens";
import { colorDepth, halfBlockLines, type ColorDepth } from "./halfblock";
import { imageMeta, imageSupport, type ImageSupport, type LoadedImage } from "./images";
import { itermImage, KITTY_CLEAR_PLACEMENTS, kittyFree, kittyPlace, kittyTransmit } from "./protocols";
import { fitCells, makeThumb, type Thumb, type ToPng } from "./thumbs";

const THUMB_CACHE = 16;
const ART_CACHE = 32;

export interface ImageLayerOptions {
  imageSupport?: ImageSupport;
  colorDepth?: ColorDepth;
  toPng?: ToPng;
}

// An image drawn by the terminal itself over blank cells of the frame.
export interface Placement {
  slot: string;
  thumb: Thumb;
  name: string;
  row: number;
  col: number;
  cols: number;
  rows: number;
}

// Lines to put in the frame for one image, plus where the terminal should paint
// pixels over them (null when the lines already are the picture, or a caption).
export interface ImageCells {
  lines: string[];
  box: { line: number; col: number; cols: number; rows: number } | null;
}

export interface CachedThumb {
  ready: Thumb | null;
  promise: Promise<Thumb | null>;
}

function remember<V>(cache: Map<string, V>, key: string, value: V, cap: number): V {
  cache.set(key, value);
  while (cache.size > cap) cache.delete(cache.keys().next().value!);
  return value;
}

function signatureOf(placements: Placement[]): string {
  return placements.map((p) => p.slot + "@" + p.row + "," + p.col + "," + p.cols + "x" + p.rows).join("|");
}

export class ImageLayer {
  private thumbs = new Map<string, CachedThumb>();
  private art = new Map<string, string[]>();
  private signature = "";
  private kittySent = new Set<number>();
  private kittySlots = new Map<string, number>();
  private kittyPlaced = false;

  constructor(private readonly options: ImageLayerOptions = {}) {}

  get support(): ImageSupport {
    return this.options.imageSupport ?? imageSupport();
  }

  private get depth(): ColorDepth {
    return this.options.colorDepth ?? colorDepth();
  }

  // Shared by the composer tray and the transcript: one decode per image, however
  // many frames it appears in.
  thumbFor(image: LoadedImage): CachedThumb {
    const key = image.path + ":" + image.bytes + ":" + image.base64.slice(-32);
    const cached = this.thumbs.get(key);
    if (cached) return cached;
    const entry: CachedThumb = { ready: null, promise: Promise.resolve(null) };
    entry.promise = makeThumb(image, this.options.toPng)
      .then((thumb) => (entry.ready = thumb))
      .catch(() => null);
    return remember(this.thumbs, key, entry, THUMB_CACHE);
  }

  // Lines for an image that fits in maxCols × maxRows cells: blank cells the terminal
  // paints over, half-block art, or a one-line note when there are no pixels to show.
  cells(image: LoadedImage | null, thumb: Thumb | null, maxCols: number, maxRows: number): ImageCells {
    if (!thumb) return { lines: [C.dim + (image ? "▤ preparing…" : "▤ loading…") + C.reset], box: null };
    const fit = fitCells(thumb.width, thumb.height, maxCols, maxRows);
    if (this.canPaint(thumb)) return { lines: new Array<string>(fit.rows).fill(""), box: { line: 0, col: 0, ...fit } };
    if (thumb.pixels) return { lines: this.halfBlocks(thumb, fit.cols, fit.rows), box: null };
    return { lines: [C.dim + (image ? imageMeta(image) : "") + C.reset], box: null };
  }

  // A transcript entry: caption, then the picture indented under it.
  captioned(image: LoadedImage, thumb: Thumb | null, maxCols: number, maxRows: number): ImageCells {
    const caption = C.teal + "▤ " + C.reset + C.bold + image.name + C.reset + C.dim + "  " + imageMeta(image) + C.reset;
    if (!thumb) return { lines: [caption], box: null };
    const body = this.cells(image, thumb, maxCols, maxRows);
    if (!body.box && !thumb.pixels) return { lines: [caption], box: null };
    return {
      lines: [caption, ...body.lines.map((line) => "  " + line)],
      box: body.box && { ...body.box, line: body.box.line + 1, col: body.box.col + 2 },
    };
  }

  // True when the last frame's images sit exactly where these placements are.
  unchanged(placements: Placement[]): boolean {
    return signatureOf(placements) === this.signature;
  }

  // Escapes that paint the placements. With `rewritten`, only those crossing a row
  // the frame just rewrote — writing text over iTerm pixels erases them.
  paint(placements: Placement[], rewritten?: Set<number>): string {
    this.signature = signatureOf(placements);
    let out = "";
    for (const p of placements) {
      if (rewritten && ![...rewritten].some((row) => row >= p.row && row < p.row + p.rows)) continue;
      out += this.payload(p);
    }
    return out;
  }

  // Escapes that take every painted image off the screen. iTerm pixels go with the
  // cells; kitty keeps placements on a separate layer that must be cleared.
  wipe(): string {
    this.signature = "";
    if (!this.kittyPlaced) return "";
    this.kittyPlaced = false;
    return KITTY_CLEAR_PLACEMENTS;
  }

  // Escapes that also free the pixels kitty is holding for us — before leaving the alt screen.
  dispose(): string {
    let out = this.wipe();
    for (const id of this.kittySent) out += kittyFree(id);
    this.kittySent.clear();
    return out;
  }

  private canPaint(thumb: Thumb): boolean {
    const support = this.support;
    return (support === "iterm" && thumb.inline !== null) || (support === "kitty" && thumb.png !== null);
  }

  // Resampled only when the box changes, not on every keystroke.
  private halfBlocks(thumb: Thumb, cols: number, rows: number): string[] {
    const depth = this.depth;
    const key = thumb.id + ":" + cols + "x" + rows + ":" + depth;
    const cached = this.art.get(key);
    if (cached) return cached;
    return remember(this.art, key, thumb.pixels ? halfBlockLines(thumb.pixels, cols, rows, depth) : [], ART_CACHE);
  }

  private payload(p: Placement): string {
    const at = "\x1b[" + (p.row + 1) + ";" + (p.col + 1) + "H";
    const support = this.support;
    if (support === "iterm") return p.thumb.inline ? at + itermImage(p.thumb.inline, p.name, p.cols, p.rows, true) : "";
    if (support !== "kitty" || !p.thumb.png) return "";
    let out = "";
    if (!this.kittySent.has(p.thumb.id)) {
      out += kittyTransmit(p.thumb.id, p.thumb.png);
      this.kittySent.add(p.thumb.id);
    }
    let slot = this.kittySlots.get(p.slot);
    if (slot === undefined) {
      slot = this.kittySlots.size + 1;
      this.kittySlots.set(p.slot, slot);
    }
    this.kittyPlaced = true;
    return out + at + kittyPlace(p.thumb.id, slot, p.cols, p.rows);
  }
}
