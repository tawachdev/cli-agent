import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { BRAND_PALETTE, DEFAULT_BRAND, DEFAULT_COLORS } from "../shared/brand";

const NAME_RE = /^[A-Za-z]{2,12}$/;

const fileSchema = z.object({
  name: z.string().regex(NAME_RE),
  colors: z.tuple([z.string(), z.string()]).refine(
    (colors) => colors.every((color) => color in BRAND_PALETTE),
    "unknown color name",
  ),
});

export interface BrandIdentity {
  name: string;
  colors: [string, string];
  source: "file" | "env" | "default";
}

export function validName(value: string | undefined): string | null {
  return value && NAME_RE.test(value) ? value.toUpperCase() : null;
}

export function validColors(value: [string, string] | undefined): [string, string] | null {
  if (!value) return null;
  const lowered = value.map((color) => color.trim().toLowerCase());
  return lowered.every((color) => color in BRAND_PALETTE) ? (lowered as [string, string]) : null;
}

export class BrandStore {
  constructor(
    private readonly workspaceRoot: string,
    private readonly env: Record<string, string | undefined>,
  ) {}

  private path(): string {
    return join(this.workspaceRoot, ".agent", "brand.json");
  }

  private read(): { name: string; colors: [string, string] } | null {
    if (!existsSync(this.path())) return null;
    try {
      const parsed = fileSchema.safeParse(JSON.parse(readFileSync(this.path(), "utf8")));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  async write(name?: string, colors?: [string, string]): Promise<void> {
    const current = this.read();
    const next = {
      name: (name ? validName(name) : undefined) ?? current?.name ?? validName(this.env["AGENT_NAME"]) ?? DEFAULT_BRAND,
      colors: colors ?? current?.colors ?? validColors([this.env["AGENT_COLORS"]?.split(",")[0] ?? "", this.env["AGENT_COLORS"]?.split(",")[1] ?? ""]) ?? DEFAULT_COLORS,
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
    const rawColors = (this.env["AGENT_COLORS"] ?? "").split(",");
    const envColors = validColors([rawColors[0] ?? "", rawColors[1] ?? ""]);
    if (file) return { name: file.name, colors: file.colors, source: "file" };
    if (envName || envColors) {
      return { name: envName ?? DEFAULT_BRAND, colors: envColors ?? DEFAULT_COLORS, source: "env" };
    }
    return { name: DEFAULT_BRAND, colors: DEFAULT_COLORS, source: "default" };
  }
}
