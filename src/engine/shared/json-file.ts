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
  } catch {}
  const aside = path + ".corrupt-" + Date.now();
  renameSync(path, aside);
  console.error("[mimon] " + path + " was not valid JSON; kept it as " + aside + " and started fresh");
  return {};
}

export function writeJsonAtomic(path: string, value: unknown, mode?: number): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, "." + basename(path) + "." + process.pid + "." + Math.random().toString(36).slice(2) + ".tmp");
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", mode === undefined ? undefined : { mode });
  if (mode !== undefined) chmodSync(tmp, mode);
  renameSync(tmp, path);
}
