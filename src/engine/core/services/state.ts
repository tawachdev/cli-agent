import { existsSync } from "node:fs";
import { join } from "node:path";

export interface ServicesState {
  ollamaEnabled: boolean;
}

const FILE = "services.json";

export function readServicesState(dataDir: string): ServicesState {
  const file = join(dataDir, FILE);
  try {
    if (existsSync(file)) {
      const parsed = JSON.parse(require("node:fs").readFileSync(file, "utf8")) as Partial<ServicesState>;
      if (typeof parsed.ollamaEnabled === "boolean") {
        return { ollamaEnabled: parsed.ollamaEnabled };
      }
    }
  } catch {
    return { ollamaEnabled: true };
  }
  return { ollamaEnabled: true };
}

export function writeOllamaEnabled(dataDir: string, enabled: boolean) {
  const state = readServicesState(dataDir);
  const file = join(dataDir, FILE);
  try {
    require("node:fs").writeFileSync(file, JSON.stringify({ ...state, ollamaEnabled: enabled }, null, 2));
  } catch {
    return;
  }
}

export function spawnOllamaIfEnabled(dataDir: string) {
  if (!readServicesState(dataDir).ollamaEnabled) return;
  try {
    const p = Bun.spawn(["/opt/homebrew/bin/ollama", "serve"], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    p.unref();
  } catch {
    return;
  }
}
