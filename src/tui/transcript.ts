import { ANSI as C } from "../shared/tokens";
import type { ImageLayer } from "./image-layer";
import type { LoadedImage } from "./images";
import { wrap } from "./term";
import type { Thumb } from "./thumbs";

type Entry = { kind: "text"; text: string } | { kind: "image"; id: string };

interface SentImage {
  image: LoadedImage;
  thumb: Thumb | null;
}

export interface TranscriptRow {
  text: string;
  place?: { slot: string; thumb: Thumb; name: string; col: number; cols: number; rows: number };
}

export class Transcript {
  private entries: Entry[] = [];
  private images = new Map<string, SentImage>();
  private imageSeq = 0;
  private streaming = false;

  constructor(
    private readonly layer: ImageLayer,
    private readonly refresh: () => void,
  ) {}

  push(text: string): void {
    this.entries.push({ kind: "text", text });
    this.streaming = false;
  }

  stream(text: string): void {
    const last = this.entries.at(-1);
    if (this.streaming && last?.kind === "text") last.text += text;
    else this.entries.push({ kind: "text", text });
    this.streaming = true;
  }

  endStream(): void {
    this.streaming = false;
  }

  replaceLast(text: string): void {
    if (this.entries.length === 0) this.entries.push({ kind: "text", text });
    else this.entries[this.entries.length - 1] = { kind: "text", text };
  }

  addImage(image: LoadedImage): void {
    const id = String(++this.imageSeq);
    const cached = this.layer.thumbFor(image);
    const sent: SentImage = { image, thumb: cached.ready };
    this.images.set(id, sent);
    this.entries.push({ kind: "image", id });
    this.streaming = false;
    if (!sent.thumb) {
      void cached.promise.then((thumb) => {
        sent.thumb = thumb;
        this.refresh();
      });
    }
  }

  lastImage(): LoadedImage | null {
    return [...this.images.values()].at(-1)?.image ?? null;
  }

  rows(budget: number, width: number, imageBox: { cols: number; rows: number }): TranscriptRow[] {
    const rows: TranscriptRow[] = [];
    for (let i = this.entries.length - 1; i >= 0 && rows.length < budget; i--) {
      const entry = this.entries[i]!;
      if (entry.kind === "text") {
        const wrapped = wrap(entry.text, width);
        for (let j = wrapped.length - 1; j >= 0 && rows.length < budget; j--) rows.unshift({ text: wrapped[j]! });
        continue;
      }
      const sent = this.images.get(entry.id);
      if (!sent) continue;
      let block = this.layer.captioned(sent.image, sent.thumb, imageBox.cols, imageBox.rows);
      if (rows.length + block.lines.length > budget) block = { lines: block.lines.slice(0, 1), box: null };
      for (let j = block.lines.length - 1; j >= 0 && rows.length < budget; j--) {
        const box = block.box;
        rows.unshift(
          box && j === box.line && sent.thumb
            ? { text: block.lines[j]!, place: { slot: "chat:" + entry.id, thumb: sent.thumb, name: sent.image.name, col: box.col, cols: box.cols, rows: box.rows } }
            : { text: block.lines[j]! },
        );
      }
    }
    return rows;
  }

  plainRows(budget: number, width: number): string[] {
    const rows: string[] = [];
    for (let i = this.entries.length - 1; i >= 0 && rows.length < budget; i--) {
      const entry = this.entries[i]!;
      if (entry.kind === "image") {
        const sent = this.images.get(entry.id);
        if (sent) rows.unshift(C.teal + "▤ " + C.reset + sent.image.name);
        continue;
      }
      const wrapped = wrap(entry.text, width);
      for (let j = wrapped.length - 1; j >= 0 && rows.length < budget; j--) rows.unshift(wrapped[j]!);
    }
    return rows;
  }

  get isEmpty(): boolean {
    return this.entries.length === 0;
  }
}
