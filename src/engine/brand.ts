import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { BRAND_PALETTE, DEFAULT_BRAND, DEFAULT_COLORS, validColorList } from "../shared/brand";

const NAME_RE = /^[A-Za-z]{2,12}$/;

const fileSchema = z.object({
  name: z.string().regex(NAME_RE),
  colors: z.array(z.string()).min(1).max(12).refine(
    (colors) => colors.every((color) => color in BRAND_PALETTE),
    "unknown color name",
  ),
});

export interface BrandIdentity {
  name: string;
  colors: string[];
  source: "file" | "env" | "default";
}

export function validName(value: string | undefined): string | null {
  return value && NAME_RE.test(value) ? value.toUpperCase() : null;
}

export function validColors(value: string[] | undefined): string[] | null {
  return validColorList(value);
}

function envColors(env: Record<string, string | undefined>): string[] | null {
  const raw = (env["AGENT_COLORS"] ?? "").split(",").filter((part) => part.trim() !== "");
  return validColorList(raw);
}

export class BrandStore {
  constructor(
    private readonly workspaceRoot: string,
    private readonly env: Record<string, string | undefined>,
  ) {}

  private path(): string {
    return join(this.workspaceRoot, ".agent", "brand.json");
  }

  private read(): { name: string; colors: string[] } | null {
    if (!existsSync(this.path())) return null;
    try {
      const parsed = fileSchema.safeParse(JSON.parse(readFileSync(this.path(), "utf8")));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  async write(name?: string, colors?: string[]): Promise<void> {
    const current = this.read();
    const next = {
      name: (name ? validName(name) : undefined) ?? current?.name ?? validName(this.env["AGENT_NAME"]) ?? DEFAULT_BRAND,
      colors: (colors ? validColors(colors) : undefined) ?? current?.colors ?? envColors(this.env) ?? DEFAULT_COLORS,
    };
    const dir = join(this.workspaceRoot, ".agent");
    mkdirSync(dir, { recursive: true });
    await Bun.write(this.path(), JSON.stringify(next, null, 2) + "\n");
  }

  async reset(): Promise<void> {
    const dir = join(this.workspaceRoot, ".agent");
    mkdirSync(dir, { recursive: true });
    await Bun.write(this.path(), JSON.stringify({ name: DEFAULT_BRAND, colors: DEFAULT_COLORS }, null, 2) + "\n");
  }

  effective(): BrandIdentity {
    const file = this.read();
    const envName = validName(this.env["AGENT_NAME"]);
    const fromEnv = envColors(this.env);
    if (file) return { name: file.name, colors: file.colors, source: "file" };
    if (envName || fromEnv) {
      return { name: envName ?? DEFAULT_BRAND, colors: fromEnv ?? DEFAULT_COLORS, source: "env" };
    }
    return { name: DEFAULT_BRAND, colors: DEFAULT_COLORS, source: "default" };
  }
}
