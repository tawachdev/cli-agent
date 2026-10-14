import { ANSI as C } from "../../shared/tokens";
import type { Key } from "../keys";
import { trunc } from "../term";
import type { Frame } from "./frame";

export interface ModelPickHooks {
  onBindModel(role: string, binding: string): void;
  onWizardModel(name: string, model: string): void;
}

const WINDOW = 10;

export class ModelPick {
  private provider = "";
  private models: string[] = [];
  private index = 0;
  private offset = 0;
  private role = "";

  constructor(
    private readonly frame: Frame,
    private readonly hooks: ModelPickHooks,
  ) {}

  open(provider: string, models: string[], preferred?: string, role?: string): boolean {
    this.provider = provider;
    this.models = models;
    this.index = preferred ? Math.max(0, models.indexOf(preferred)) : 0;
    this.offset = 0;
    this.role = role ?? "";
    if (models.length === 0) return false;
    this.scrollIntoView();
    return true;
  }

  lines(): string[] {
    const budget = Math.max(6, this.frame.usable - 4);
    const body = [C.dim + trunc("pick a model — it drives all tiers (change later in /model)", budget) + C.reset];
    const end = Math.min(this.models.length, this.offset + WINDOW);
    for (let i = this.offset; i < end; i++) {
      const active = i === this.index;
      body.push((active ? C.teal + "❯ " + C.reset : "  ") + (active ? C.cream + this.models[i]! + C.reset : this.models[i]!));
    }
    if (this.models.length > WINDOW) body.push(C.dim + `${this.index + 1}/${this.models.length}` + C.reset);
    body.push(C.dim + trunc("↑↓ move · enter select · esc keep current", budget) + C.reset);
    return body;
  }

  handleKey(key: Key): void {
    const count = this.models.length;
    if (count === 0 || key.kind === "escape") {
      this.close();
    } else if (key.kind === "up" || key.kind === "down") {
      this.index = (this.index + (key.kind === "up" ? count - 1 : 1)) % count;
      this.scrollIntoView();
      this.frame.refresh();
    } else if (key.kind === "enter") {
      const model = this.models[this.index]!;
      this.close();
      if (this.role) this.hooks.onBindModel(this.role, this.provider + "/" + model);
      else this.hooks.onWizardModel(this.provider, model);
    }
  }

  private close(): void {
    this.frame.closeView();
    this.frame.refresh();
  }

  private scrollIntoView(): void {
    if (this.index < this.offset) this.offset = this.index;
    if (this.index >= this.offset + WINDOW) this.offset = this.index - WINDOW + 1;
  }
}
