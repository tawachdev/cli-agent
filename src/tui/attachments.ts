// Images attached to the message being written: dropped or typed paths, clipboard
// pastes, and macOS screenshot paths whose file is already gone. They wait here
// until the message is sent.
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { cwd } from "node:process";
import type { ImageLayer } from "./image-layer";
import { imageChipName, type LoadedImage, type LocatedImage, loadImagesFromPaths, locateImagePaths, MAX_IMAGES } from "./images";
import type { Thumb } from "./thumbs";

export interface Attachment {
  path: string;
  name: string;
  image: LoadedImage | null;
  thumb: Thumb | null;
  loading: Promise<void> | null;
}

// The prompt the attachments come from: image paths are lifted out of its text.
export interface AttachmentHost {
  input: string;
  cursor: number;
  refresh(): void;
  notice(message: string): void;
}

export type ClipboardSave = (destDir: string) => Promise<string | null>;

const BASE64_IMAGE_MIN = 500;

export function looksLikeBase64Image(text: string): boolean {
  const body = text.replace(/\s+/g, "");
  if (body.length < BASE64_IMAGE_MIN) return false;
  if (/^data:image\/[a-z+.-]+;base64,/.test(body)) return true;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(body)) return false;
  return body.startsWith("iVBORw0KGgo") || body.startsWith("/9j/") || body.startsWith("R0lGODlh") || body.startsWith("UklGR");
}

export class Attachments {
  private pending: Attachment[] = [];
  private paths = new Set<string>();
  private recovering = new Set<string>();
  // files we saved from the clipboard ourselves, deleted once sent
  private owned = new Set<string>();
  private jobs = new Set<Promise<void>>();

  constructor(
    private readonly host: AttachmentHost,
    private readonly images: ImageLayer,
    private readonly clipboardSave: ClipboardSave,
  ) {}

  get list(): readonly Attachment[] {
    return this.pending;
  }

  get count(): number {
    return this.pending.length;
  }

  // Lifts every image path out of the prompt text and starts loading it.
  detect(): void {
    const located = locateImagePaths(this.host.input);
    for (const hit of located.reverse()) {
      if (this.paths.has(hit.path)) continue;
      if (!existsSync(hit.path)) {
        this.track(this.recover(hit));
        continue;
      }
      if (this.pending.length >= MAX_IMAGES) {
        this.paths.add(hit.path);
        this.host.notice("✘ " + hit.path + " — skipped, max " + MAX_IMAGES + " images per message");
        continue;
      }
      this.cutFromInput(hit);
      this.add(hit.path);
    }
    // a path pasted on its own leaves only whitespace behind — give the prompt back
    if (located.length > 0 && this.pending.length > 0 && this.host.input.trim() === "") {
      this.host.input = "";
      this.host.cursor = 0;
    }
    if (located.length > 0) this.host.refresh();
  }

  pasteFromClipboard(): void {
    this.track(this.saveClipboard());
  }

  removeLast(): void {
    const removed = this.pending.pop();
    if (removed) this.paths.delete(removed.path);
  }

  clear(): void {
    this.pending = [];
    this.paths.clear();
  }

  loaded(): LoadedImage[] {
    return this.pending.flatMap((p) => (p.image ? [p.image] : []));
  }

  // Enter can land while a drop or clipboard paste is still being read; wait for it
  // so the image goes out with the message instead of being silently dropped.
  async settle(): Promise<void> {
    await Promise.all([...this.jobs]);
    await Promise.all(this.pending.map((p) => p.loading ?? Promise.resolve()));
  }

  // Hands the loaded images to the message being sent and empties the tray.
  take(): LoadedImage[] {
    const taken = this.loaded();
    const missing = this.pending.filter((p) => !p.image).map((p) => p.path);
    this.clear();
    for (const path of missing) this.host.notice("✘ " + path + " — could not be loaded, skipped");
    return taken;
  }

  releaseSent(): void {
    for (const path of this.owned) {
      try {
        rmSync(path, { force: true });
      } catch {
        // best effort: the uploads folder is swept on the next engine start too
      }
    }
    this.owned.clear();
  }

  private track(job: Promise<void>): void {
    this.jobs.add(job);
    void job.finally(() => this.jobs.delete(job));
  }

  private cutFromInput(hit: LocatedImage): void {
    this.host.input = this.host.input.slice(0, hit.start) + this.host.input.slice(hit.end);
    this.host.cursor = Math.min(this.host.cursor, this.host.input.length);
  }

  private add(path: string): Promise<void> {
    this.paths.add(path);
    this.pending.push({ path, name: imageChipName(path), image: null, thumb: null, loading: null });
    return this.load(path);
  }

  private load(path: string): Promise<void> {
    const job = (async () => {
      const { images, errors } = await loadImagesFromPaths([path]);
      const entry = this.pending.find((p) => p.path === path);
      if (!entry) return;
      if (images[0]) {
        entry.image = images[0];
        const cached = this.images.thumbFor(entry.image);
        entry.thumb = cached.ready;
        this.host.refresh();
        if (!entry.thumb) {
          entry.thumb = await cached.promise;
          this.host.refresh();
        }
      } else if (errors[0]) {
        this.pending = this.pending.filter((p) => p.path !== path);
        this.paths.delete(path);
        this.host.notice("✘ " + errors[0]);
      }
    })();
    const entry = this.pending.find((p) => p.path === path);
    if (entry) entry.loading = job;
    return job;
  }

  private uploadsDir(): string {
    return join(cwd(), ".agent", "uploads");
  }

  private async saveClipboard(): Promise<void> {
    if (this.pending.length >= MAX_IMAGES) {
      this.host.notice("✘ skipped — max " + MAX_IMAGES + " images per message");
      return;
    }
    if (this.recovering.has("clipboard")) return;
    this.recovering.add("clipboard");
    try {
      const saved = await this.clipboardSave(this.uploadsDir());
      if (!saved) {
        this.host.notice("✘ pasted image could not be read — copy it again (Cmd+C), then paste here");
        return;
      }
      if (this.paths.has(saved)) return;
      await this.add(saved);
    } finally {
      this.recovering.delete("clipboard");
    }
  }

  // macOS hands drag-and-drop screenshots over as a TemporaryItems path that is
  // often deleted before we read it; the same image is still on the clipboard.
  private async recover(hit: LocatedImage): Promise<void> {
    if (!hit.path.includes("TemporaryItems")) return;
    if (this.recovering.has(hit.path) || this.paths.has(hit.path)) return;
    if (this.pending.length >= MAX_IMAGES) {
      this.host.notice("✘ skipped — max " + MAX_IMAGES + " images per message");
      return;
    }
    this.recovering.add(hit.path);
    try {
      const saved = await this.clipboardSave(this.uploadsDir());
      const current = locateImagePaths(this.host.input).find((l) => l.path === hit.path);
      if (!current) return;
      if (!saved) {
        this.host.notice("✘ pasted image is gone and the clipboard holds no image — copy it again (Cmd+C), then paste here");
        return;
      }
      this.cutFromInput(current);
      if (this.host.input.trim() === "") this.host.input = "";
      this.host.cursor = Math.min(this.host.cursor, this.host.input.length);
      this.owned.add(saved);
      await this.add(saved);
    } finally {
      this.recovering.delete(hit.path);
    }
  }
}
