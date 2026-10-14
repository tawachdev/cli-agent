// /providers and the /setup wizard: browse providers, set / remove / test a key,
// bind one of a provider's models to a tier, or add any OpenAI-compatible endpoint.
import { brandName } from "../../shared/brand";
import { ANSI as C } from "../../shared/tokens";
import { BIND_TARGETS, type ProviderEntry } from "../catalog";
import type { Key } from "../keys";
import { trunc } from "../term";
import type { Frame } from "./frame";

export interface ProvidersHooks {
  onSetKey(name: string, key: string): void;
  onRemoveKey(name: string): void;
  onTestProvider(name: string, model: string): void;
  onBindModel(role: string, binding: string): void;
  onWizardKey(name: string, key: string): void;
  onAddProvider(name: string, baseUrl: string, models: string[]): void;
}

type Step = "list" | "provider" | "key" | "bind" | "add";

const PASTE_FIELD_CAP = 200;
const ADD_LABELS = ["name (a-z, 0-9, -)", "base url (https://…)", "models (comma separated)"];
const ADD_FIELD_NAMES = ["name", "base url", "models"];

export class ProvidersFlow {
  private step: Step = "list";
  private providers: ProviderEntry[] = [];
  private listIndex = 0;
  private openProvider: ProviderEntry | null = null;
  private itemIndex = 0;
  private wizard = false;
  private keyBuffer = "";
  private bindModel = "";
  private addFields: [string, string, string] = ["", "", ""];
  private addIndex = 0;
  private addError = "";

  constructor(
    private readonly frame: Frame,
    private readonly hooks: ProvidersHooks,
  ) {}

  // re-entering /providers lands back on the provider that was open, if it still exists
  open(providers: ProviderEntry[]): void {
    this.setProviders(providers);
    this.step = this.openProvider ? "provider" : "list";
    this.listIndex = Math.min(this.listIndex, Math.max(0, providers.length - 1));
  }

  openWizard(providers: ProviderEntry[]): void {
    this.providers = providers;
    this.openProvider = null;
    this.wizard = true;
    this.step = "list";
    this.listIndex = 0;
  }

  setProviders(providers: ProviderEntry[]): void {
    this.providers = providers;
    if (this.openProvider) {
      this.openProvider = providers.find((p) => p.name === this.openProvider?.name) ?? null;
    }
  }

  // the list and provider screens show key status, so they repaint on new data
  showsProviderData(): boolean {
    return this.step === "list" || this.step === "provider";
  }

  // A paste lands in the field being typed; returns false when this screen takes no text.
  paste(text: string): boolean {
    const flat = text.replace(/\n+/g, " ");
    if (this.step === "key") {
      this.keyBuffer += flat.slice(0, PASTE_FIELD_CAP);
    } else if (this.step === "add") {
      this.addFields[this.addIndex] = (this.addFields[this.addIndex]! + flat).slice(0, PASTE_FIELD_CAP);
      this.addError = "";
    } else {
      return false;
    }
    this.frame.refresh();
    return true;
  }

  lines(): string[] {
    if (this.step === "list") return this.listLines();
    if (this.step === "provider") return this.providerLines();
    if (this.step === "key") return this.keyLines();
    if (this.step === "bind") return this.bindLines();
    return this.addLines();
  }

  handleKey(key: Key): void {
    if (this.step === "key") this.keyKey(key);
    else if (this.step === "add") this.addKey(key);
    else this.menuKey(key);
  }

  private go(step: Step): void {
    this.step = step;
    this.frame.refresh();
  }

  private close(): void {
    this.wizard = false;
    this.frame.closeView();
    this.frame.refresh();
  }

  private line(text: string): string {
    return "  " + C.dim + trunc(text, Math.max(6, this.frame.usable - 2)) + C.reset;
  }

  private choice(selected: boolean, text: string): string {
    return "  " + (selected ? C.teal + "❯ " + C.reset : "  ") + text;
  }

  // ── list ──

  private listLines(): string[] {
    const usable = this.frame.usable;
    const title = usable >= 22 ? "── cloud providers " + "─".repeat(Math.max(4, Math.min(usable - 24, 28))) : "── providers ──";
    const lines: string[] = [];
    if (this.wizard) {
      lines.push("  " + C.gold + C.bold + "✦ welcome to " + brandName().toLowerCase() + C.reset);
      lines.push(this.line("pick a provider and paste its API key — it never leaves this machine"));
    }
    lines.push(this.line(title));
    const nameBudget = Math.max(8, usable - 12 - 8);
    this.providers.forEach((p, i) => {
      const sel = i === this.listIndex;
      const name = (sel ? C.bold + C.teal : C.bold + C.cream) + trunc(p.name, nameBudget) + C.reset;
      const status = p.keySet ? C.green + "key saved" + C.reset : C.dim + "no key" + C.reset;
      lines.push(this.choice(sel, name + "  " + status));
    });
    if (this.providers.length === 0) lines.push("  " + C.dim + "no providers" + C.reset);
    const addSelected = this.listIndex === this.providers.length;
    lines.push(this.choice(addSelected, addSelected ? C.bold + C.teal + "+ add provider (any OpenAI-compatible URL)" + C.reset : C.dim + "+ add provider" + C.reset));
    lines.push(this.line(usable >= 42 ? "↑↓ move · enter open · esc close" : "↑↓ · enter · esc"));
    return lines;
  }

  // ── one provider: its models (enter binds) and key actions ──

  private actions(p: ProviderEntry): Array<"set" | "remove" | "test"> {
    return p.keySet ? ["set", "remove", "test"] : ["set", "test"];
  }

  private providerLines(): string[] {
    const p = this.openProvider;
    if (!p) return [];
    const items = [
      ...p.models.map((m) => ({ text: m, model: true })),
      ...this.actions(p).map((a) => ({ text: a === "set" ? (p.keySet ? "replace key" : "set key") : a + " key", model: false })),
    ];
    if (this.itemIndex >= items.length) this.itemIndex = Math.max(0, items.length - 1);
    const lines = [this.line("── " + p.name + (p.keySet ? " · key saved" : " · no key") + " ")];
    const budget = Math.max(8, this.frame.usable - 6);
    items.forEach((item, i) => {
      const sel = i === this.itemIndex;
      const text = trunc(item.text, budget);
      lines.push(this.choice(sel, sel ? C.bold + C.teal + text + C.reset : (item.model ? C.cream : C.dim) + text + C.reset));
    });
    lines.push(this.line("↑↓ move · enter select · esc back"));
    return lines;
  }

  // ── bind a model to a tier ──

  private bindLines(): string[] {
    const lines = [this.line("── bind " + this.bindModel + " to ──")];
    const budget = Math.max(8, this.frame.usable - 6);
    BIND_TARGETS.forEach((target, i) => {
      const sel = i === this.itemIndex;
      lines.push(this.choice(sel, (sel ? C.bold + C.teal : C.bold + C.cream) + trunc(target.label, budget) + C.reset));
    });
    lines.push(this.line("↑↓ move · enter bind · esc cancel"));
    return lines;
  }

  private menuKey(key: Key): void {
    const count =
      this.step === "list" ? this.providers.length + 1
      : this.step === "bind" ? BIND_TARGETS.length
      : (this.openProvider?.models.length ?? 0) + (this.openProvider?.keySet ? 3 : 2);
    if (key.kind === "escape") {
      if (this.step === "provider") {
        this.openProvider = null;
        this.go("list");
      } else if (this.step === "bind") {
        this.go("provider");
      } else {
        this.close();
      }
      return;
    }
    if (key.kind === "up" || key.kind === "down") {
      const delta = key.kind === "up" ? -1 : 1;
      if (this.step === "list") this.listIndex = (this.listIndex + delta + count) % count;
      else this.itemIndex = (this.itemIndex + delta + count) % count;
      this.frame.refresh();
    } else if (key.kind === "enter") {
      this.select();
    }
  }

  private select(): void {
    if (this.step === "list") {
      if (this.listIndex >= this.providers.length) {
        this.addFields = ["", "", ""];
        this.addIndex = 0;
        this.addError = "";
        this.go("add");
        return;
      }
      const p = this.providers[this.listIndex];
      if (!p) return;
      this.openProvider = p;
      this.itemIndex = 0;
      this.go(this.wizard ? "key" : "provider");
      return;
    }
    const p = this.openProvider;
    if (this.step === "provider") {
      if (!p) return;
      if (this.itemIndex < p.models.length) {
        this.bindModel = p.models[this.itemIndex] ?? "";
        this.itemIndex = 0;
        this.go("bind");
        return;
      }
      const action = this.actions(p)[this.itemIndex - p.models.length];
      if (action === "set") {
        this.keyBuffer = "";
        this.go("key");
      } else if (action === "remove") {
        this.hooks.onRemoveKey(p.name);
      } else if (action === "test") {
        this.hooks.onTestProvider(p.name, p.models[0] ?? "");
      }
      return;
    }
    const target = BIND_TARGETS[this.itemIndex];
    if (!target || !p || !this.bindModel) return;
    this.openProvider = null;
    this.close();
    this.hooks.onBindModel(target.role, p.name + "/" + this.bindModel);
  }

  // ── API key ──

  private keyLines(): string[] {
    const usable = this.frame.usable;
    const masked = "●".repeat(Math.min(this.keyBuffer.length, Math.max(4, usable - 40)));
    return this.frame.boxed("provider key", [
      C.bold + trunc("API key for " + (this.openProvider?.name ?? ""), usable - 6) + C.reset,
      C.cream + masked + C.reset + C.inverse + " " + C.reset,
      C.dim + trunc("stored in your Keychain — never displayed, never logged", Math.max(6, usable - 6)) + C.reset,
      C.dim + trunc("enter save · esc cancel", Math.max(6, usable - 6)) + C.reset,
    ]);
  }

  private keyKey(key: Key): void {
    if (key.kind === "char") {
      this.keyBuffer += key.ch;
      this.frame.refresh();
    } else if (key.kind === "backspace") {
      this.keyBuffer = this.keyBuffer.slice(0, -1);
      this.frame.refresh();
    } else if (key.kind === "enter") {
      const name = this.openProvider?.name ?? "";
      const value = this.keyBuffer;
      const wizard = this.wizard;
      this.keyBuffer = "";
      if (wizard) {
        this.openProvider = null;
        this.close();
      } else {
        this.go("provider");
      }
      if (name && value) {
        if (wizard) this.hooks.onWizardKey(name, value);
        else this.hooks.onSetKey(name, value);
      }
    } else if (key.kind === "escape") {
      this.keyBuffer = "";
      if (this.wizard) this.openProvider = null;
      this.go(this.wizard ? "list" : "provider");
    }
  }

  // ── add an OpenAI-compatible provider ──

  private addLines(): string[] {
    const usable = this.frame.usable;
    const budget = Math.max(8, this.frame.innerWidth() - 2);
    const body = ADD_LABELS.map((labelText, i) => {
      const active = i === this.addIndex;
      const label = trunc(labelText, 24);
      const value = this.addFields[i]!;
      const room = budget - label.length - 2 - (active ? 1 : 0);
      const tail = room > 4 && value.length > room ? "…" + value.slice(-(room - 1)) : value;
      const field = active
        ? C.bold + label + C.reset + "  " + C.cream + tail + C.reset + C.inverse + " " + C.reset
        : value
          ? C.dim + label + C.reset + "  " + C.dim + tail + C.reset
          : C.dim + label + C.reset;
      return (active ? C.teal + "❯ " + C.reset : "  ") + field;
    });
    if (this.addError) body.push(C.red + trunc(this.addError, usable - 6) + C.reset);
    body.push(C.dim + trunc("enter next · esc cancel", Math.max(6, usable - 6)) + C.reset);
    return this.frame.boxed("add provider · any OpenAI-compatible endpoint", body);
  }

  private addFieldError(): string | null {
    const value = this.addFields[this.addIndex]!;
    if (this.addIndex < 2 && !value) return ADD_FIELD_NAMES[this.addIndex] + " is required";
    if (this.addIndex === 0 && !/^[a-z0-9][a-z0-9-]*$/.test(value)) return "name: lowercase letters, digits, -";
    if (this.addIndex === 1 && !/^https:\/\//.test(value) && !/^http:\/\/127\.0\.0\.1/.test(value)) {
      return "url must be https:// (or http://127.0.0.1)";
    }
    return null;
  }

  private resetAdd(): void {
    this.addFields = ["", "", ""];
    this.addIndex = 0;
    this.addError = "";
  }

  private addKey(key: Key): void {
    const field = this.addFields[this.addIndex]!;
    if (key.kind === "char" && field.length < PASTE_FIELD_CAP) {
      this.addFields[this.addIndex] = field + key.ch;
      this.addError = "";
      this.frame.refresh();
    } else if (key.kind === "backspace") {
      this.addFields[this.addIndex] = field.slice(0, -1);
      this.frame.refresh();
    } else if (key.kind === "up" && this.addIndex > 0) {
      this.addIndex -= 1;
      this.addError = "";
      this.frame.refresh();
    } else if (key.kind === "down" && this.addIndex < 2) {
      this.addIndex += 1;
      this.frame.refresh();
    } else if (key.kind === "enter") {
      const error = this.addFieldError();
      if (error) {
        this.addError = error;
        this.frame.refresh();
      } else if (this.addIndex < 2) {
        this.addIndex += 1;
        this.frame.refresh();
      } else {
        const [name, url, models] = this.addFields;
        const list = models.split(",").map((m) => m.trim()).filter(Boolean);
        this.resetAdd();
        this.go("list");
        this.hooks.onAddProvider(name, url, list);
      }
    } else if (key.kind === "escape") {
      this.resetAdd();
      this.go("list");
    }
  }
}
