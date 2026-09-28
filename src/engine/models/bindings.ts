import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const RUNNABLE_ROLES = ["coder", "general", "mimon1", "mimon2", "mimon3", "mimonMax"] as const;

export type RunnableRole = (typeof RUNNABLE_ROLES)[number];

const ENV_NAMES: Record<RunnableRole, string> = {
  coder: "AGENT_MODEL_CODER",
  general: "AGENT_MODEL_GENERAL",
  mimon1: "AGENT_MODEL_TIER1",
  mimon2: "AGENT_MODEL_TIER2",
  mimon3: "AGENT_MODEL_TIER3",
  mimonMax: "AGENT_MODEL_MAX",
};

export type BindingSource = "env" | "file" | "default";

export class BindingsStore {
  constructor(
    private readonly workspaceRoot: string,
    private readonly env: Record<string, string | undefined>,
    private readonly defaults: Record<RunnableRole, string>,
  ) {}

  private filePath(): string {
    return join(this.workspaceRoot, ".agent", "models.json");
  }

  private readFile(): Partial<Record<RunnableRole, string>> {
    const path = this.filePath();
    if (!existsSync(path)) return {};
    return JSON.parse(readFileSync(path, "utf8")) as Partial<Record<RunnableRole, string>>;
  }

  get(role: RunnableRole): string {
    const fromEnv = this.env[ENV_NAMES[role]];
    if (fromEnv) return fromEnv;
    const file = this.readFile();
    return file[role] ?? this.defaults[role];
  }

  source(role: RunnableRole): BindingSource {
    if (this.env[ENV_NAMES[role]]) return "env";
    return this.readFile()[role] ? "file" : "default";
  }

  all(): Record<RunnableRole, string> {
    const out = {} as Record<RunnableRole, string>;
    for (const role of RUNNABLE_ROLES) {
      out[role] = this.get(role);
    }
    return out;
  }

  async set(role: RunnableRole, binding: string): Promise<void> {
    const path = this.filePath();
    const current = existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as object) : {};
    mkdirSync(dirname(path), { recursive: true });
    await Bun.write(path, JSON.stringify({ ...current, [role]: binding }, null, 2) + "\n");
  }
}
