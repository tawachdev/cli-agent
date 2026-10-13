// Small JSON config files (keys, model bindings, brand) that the user can't afford
// to lose. A file that does not parse is moved aside instead of being treated as
// empty — otherwise the next write would replace everything in it with one entry.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export function readJsonObject(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  const text = readFileSync(path, "utf8");
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // falls through to quarantine
  }
  const aside = path + ".corrupt-" + Date.now();
  renameSync(path, aside);
  console.error("[mimon] " + path + " was not valid JSON; kept it as " + aside + " and started fresh");
  return {};
}

// Write to a temp file and rename over the target, so a crash mid-write never
// leaves a half-written file behind.
export function writeJsonAtomic(path: string, value: unknown, mode?: number): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, "." + basename(path) + "." + process.pid + "." + Math.random().toString(36).slice(2) + ".tmp");
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", mode === undefined ? undefined : { mode });
  if (mode !== undefined) chmodSync(tmp, mode);
  renameSync(tmp, path);
}
