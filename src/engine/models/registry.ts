import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import type { ModelProvider } from "./types";
import type { ModelBinding } from "./router";
import { AnthropicProvider } from "./anthropic-provider";
import { OpenAICompatProvider } from "./openai-provider";
import { envKeyName, type KeyStore } from "./keystore";

export interface ProviderDef {
  name: string;
  kind: "openai" | "anthropic";
  baseUrl: string;
  models: string[];
}

export const BUILTIN_PROVIDERS: ProviderDef[] = [
  {
    name: "anthropic",
    kind: "anthropic",
    baseUrl: "https://api.anthropic.com/v1",
    models: ["claude-sonnet-4-5", "claude-haiku-4-5", "claude-opus-4-1"],
  },
  {
    name: "openai",
    kind: "openai",
    baseUrl: "https://api.openai.com/v1",
    models: ["gpt-5", "gpt-5-mini", "gpt-4.1", "gpt-4o"],
  },
  {
    name: "deepseek",
    kind: "openai",
    baseUrl: "https://api.deepseek.com/v1",
    models: ["deepseek-chat", "deepseek-reasoner"],
  },
  {
    name: "glm",
    kind: "openai",
    baseUrl: "https://api.z.ai/api/paas/v4",
    models: ["glm-4.6", "glm-4.5", "glm-4.5-air"],
  },
  {
    name: "gemini",
    kind: "openai",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    models: ["gemini-2.5-pro", "gemini-2.5-flash"],
  },
];

export const extraProviderSchema = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  kind: z.enum(["openai", "anthropic"]),
  baseUrl: z
    .string()
    .refine((value) => value.startsWith("https://") || value.startsWith("http://127.0.0.1"), {
      message: "baseUrl must be https:// (or http://127.0.0.1 for local testing)",
    }),
  models: z.array(z.string().min(1)).default([]),
});

export async function loadExtraProviders(path: string): Promise<ProviderDef[]> {
  const file = Bun.file(path);
  if (!(await file.exists())) return [];
  const raw = await file.json();
  const parsed = z.array(extraProviderSchema).safeParse(raw);
  if (!parsed.success) {
    throw new Error(`invalid providers file ${path}: ${parsed.error.issues[0]?.message ?? "unknown"}`);
  }
  const builtinNames = new Set(BUILTIN_PROVIDERS.map((p) => p.name));
  return parsed.data.filter((p) => !builtinNames.has(p.name));
}

function instantiate(def: ProviderDef, apiKey: string): ModelProvider {
  if (def.kind === "anthropic") return new AnthropicProvider(def.baseUrl, apiKey, def.name);
  return new OpenAICompatProvider(def.baseUrl, apiKey, def.name);
}

export class ProviderRegistry {
  private readonly defs: Map<string, ProviderDef>;
  private readonly builtins: Set<string>;
  private readonly custom: Set<string> = new Set();

  constructor(
    private readonly keystore: KeyStore,
    extra: ProviderDef[],
    private readonly ollama: ModelProvider,
    private readonly providersPath?: string,
  ) {
    this.defs = new Map([...BUILTIN_PROVIDERS, ...extra].map((def) => [def.name, def]));
    this.builtins = new Set(BUILTIN_PROVIDERS.map((def) => def.name));
    for (const def of extra) this.custom.add(def.name);
  }

  has(name: string): boolean {
    return this.defs.has(name);
  }

  list(): (ProviderDef & { keySet: boolean; builtin: boolean })[] {
    return [...this.defs.values()].map((def) => ({
      ...def,
      keySet: this.keystore.get(def.name) !== null,
      builtin: this.builtins.has(def.name),
    }));
  }

  private async persistCustom(): Promise<void> {
    if (!this.providersPath) return;
    const defs = [...this.custom].map((name) => this.defs.get(name)!);
    const dir = dirname(this.providersPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    await Bun.write(this.providersPath, JSON.stringify(defs, null, 2) + "\n");
  }

  async addProvider(def: ProviderDef): Promise<void> {
    if (this.builtins.has(def.name)) {
      throw new Error(`"${def.name}" is built in — pick another name`);
    }
    const normalized: ProviderDef = { ...def, baseUrl: def.baseUrl.replace(/\/+$/, "") };
    this.defs.set(normalized.name, normalized);
    this.custom.add(normalized.name);
    await this.persistCustom();
  }

  async removeProvider(name: string): Promise<void> {
    if (this.builtins.has(name)) {
      throw new Error(`"${name}" is built in and cannot be removed`);
    }
    if (!this.defs.has(name)) throw new Error(`unknown provider: ${name}`);
    this.defs.delete(name);
    this.custom.delete(name);
    this.keystore.delete(name);
    await this.persistCustom();
  }

  splitBinding(binding: string): { def: ProviderDef | null; model: string } {
    const separator = binding.indexOf("/");
    if (separator <= 0) return { def: null, model: binding };
    const name = binding.slice(0, separator);
    const def = this.defs.get(name);
    if (!def) return { def: null, model: binding };
    const model = binding.slice(separator + 1);
    if (!model) return { def: null, model: binding };
    return { def, model };
  }

  resolve(binding: string): ModelBinding {
    const { def, model } = this.splitBinding(binding);
    if (!def) return { provider: this.ollama, model: binding };
    const apiKey = this.keystore.get(def.name);
    if (!apiKey) {
      throw new Error(`no API key for "${def.name}" — add one in Settings → Connections or set ${envKeyName(def.name)}`);
    }
    return { provider: instantiate(def, apiKey), model };
  }

  setKey(name: string, key: string): void {
    if (!this.defs.has(name)) throw new Error(`unknown provider: ${name}`);
    this.keystore.set(name, key);
  }

  deleteKey(name: string): void {
    if (!this.defs.has(name)) throw new Error(`unknown provider: ${name}`);
    this.keystore.delete(name);
  }

  async test(name: string, model: string): Promise<{ ok: boolean; error?: string }> {
    try {
      const binding = this.resolve(`${name}/${model}`);
      const request = {
        model,
        messages: [{ role: "user" as const, content: "Reply with the single word OK." }],
        numCtx: 1024,
        temperature: 0,
      };
      for await (const chunk of binding.provider.complete(request)) {
        if (chunk.type === "done") break;
      }
      return { ok: true };
    } catch (error) {
      return { ok: false, error: (error as Error).message.slice(0, 300) };
    }
  }
}
