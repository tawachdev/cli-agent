import { existsSync, mkdirSync, renameSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { resolve4, resolve6 } from "node:dns/promises";
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

const PRIVATE_V4 = /^(0\.|10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;

function isPrivateAddress(address: string): boolean {
  const value = address.toLowerCase();
  if (!value.includes(":")) return PRIVATE_V4.test(value);
  if (value === "::1" || value === "::") return true;
  const head = value.split(":")[0] ?? "";
  const first = head === "" ? Number.NaN : Number.parseInt(head, 16);
  if (!Number.isNaN(first)) {
    if ((first & 0xffc0) === 0xfe80) return true;
    if ((first & 0xfe00) === 0xfc00) return true;
  }
  if (value.startsWith("::ffff:")) {
    const tail = value.slice("::ffff:".length);
    if (tail.includes(".")) return PRIVATE_V4.test(tail);
    const [hiText, loText] = tail.split(":");
    if (hiText && loText) {
      const hi = Number.parseInt(hiText, 16);
      const lo = Number.parseInt(loText, 16);
      if (!Number.isNaN(hi) && !Number.isNaN(lo)) {
        return PRIVATE_V4.test(`${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`);
      }
    }
  }
  return false;
}

export async function safeProviderBaseUrl(value: string): Promise<boolean> {
  if (value.length === 0 || value.length > 300) return false;
  if (/[\s\x00-\x1f\x7f]/.test(value)) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.username || url.password) return false;
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const loopback = host === "127.0.0.1" || host === "localhost" || host === "::1";
  if (url.protocol === "http:") return loopback;
  if (url.protocol !== "https:") return false;
  if (loopback) return true;
  if (PRIVATE_V4.test(host)) return false;
  if (/^f[cd][0-9a-f]{2}:/.test(host) || /^fe[89ab][0-9a-f]:/.test(host)) return false;
  if (isPrivateAddress(host)) return false;
  if (!host.includes(".")) return false;
  const [v4, v6] = await Promise.allSettled([resolve4(host), resolve6(host)]);
  const records = [
    ...(v4.status === "fulfilled" ? v4.value : []),
    ...(v6.status === "fulfilled" ? v6.value : []),
  ];
  if (records.length === 0) return false;
  return !records.some((address) => isPrivateAddress(address));
}

export const extraProviderSchema = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9-]*$/).max(200),
  kind: z.enum(["openai", "anthropic"]),
  baseUrl: z.string().refine(safeProviderBaseUrl, {
    message: "baseUrl must be a public https:// URL (http:// allowed for 127.0.0.1/localhost only)",
  }),
  models: z.array(z.string().min(1).max(200)).max(128).default([]),
});

export async function loadExtraProviders(path: string): Promise<ProviderDef[]> {
  const file = Bun.file(path);
  if (!(await file.exists())) return [];
  let raw: unknown;
  try {
    raw = await file.json();
  } catch (error) {
    console.warn("[providers] corrupt providers file ignored:", (error as Error).message);
    return [];
  }
  const parsed = await z.array(extraProviderSchema).safeParseAsync(raw);
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
    private readonly fallback?: ModelProvider,
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
    const tmp = join(dir, `.${basename(this.providersPath)}.${process.pid}.tmp`);
    await Bun.write(tmp, JSON.stringify(defs, null, 2) + "\n");
    renameSync(tmp, this.providersPath);
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
    if (!def) {
      if (!this.fallback) {
        throw new Error("no provider connected — open /setup and connect one (bring its API key)");
      }
      return { provider: this.fallback, model: binding };
    }
    const apiKey = this.keystore.get(def.name);
    if (!apiKey) {
      throw new Error(`no API key for "${def.name}" — /providers → set key, or set ${envKeyName(def.name)}`);
    }
    return { provider: instantiate(def, apiKey), model };
  }

  hasKey(name: string): boolean {
    if (!this.defs.has(name)) return false;
    return this.keystore.get(name) !== null;
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
