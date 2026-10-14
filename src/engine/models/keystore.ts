import { homedir } from "node:os";
import { join } from "node:path";
import { readJsonObject, writeJsonAtomic } from "../shared/json-file";

export interface KeyStore {
  get(name: string): string | null;
  set(name: string, key: string): void;
  delete(name: string): void;
}

const SERVICE = "agent";

export function envKeyName(name: string): string {
  return `AGENT_KEY_${name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
}

function keyFile(): string {
  return join(homedir(), ".agent", "keys.json");
}

function readKeyFile(): Record<string, string> {
  const keys: Record<string, string> = {};
  for (const [name, value] of Object.entries(readJsonObject(keyFile()))) {
    if (typeof value === "string") keys[name] = value;
  }
  return keys;
}

function writeKeyFile(keys: Record<string, string>): void {
  writeJsonAtomic(keyFile(), keys, 0o600);
}

export class KeychainKeyStore implements KeyStore {
  get(name: string): string | null {
    const fromEnv = process.env[envKeyName(name)];
    if (fromEnv) return fromEnv;
    if (process.platform === "darwin") {
      const run = Bun.spawnSync(["security", "find-generic-password", "-s", SERVICE, "-a", name, "-w"]);
      const key = run.stdout.toString().trim();
      if (run.exitCode === 0 && key) return key;
    }
    const file = readKeyFile();
    return file[name] ?? null;
  }

  set(name: string, key: string): void {
    if (process.platform === "darwin") {
      const run = Bun.spawnSync(["security", "add-generic-password", "-s", SERVICE, "-a", name, "-w", key, "-U"]);
      if (run.exitCode !== 0) {
        throw new Error(`could not store the key in Keychain (exit ${run.exitCode})`);
      }
      return;
    }
    const keys = readKeyFile();
    keys[name] = key;
    writeKeyFile(keys);
  }

  delete(name: string): void {
    if (process.platform === "darwin") {
      Bun.spawnSync(["security", "delete-generic-password", "-s", SERVICE, "-a", name]);
    }
    const keys = readKeyFile();
    delete keys[name];
    writeKeyFile(keys);
  }
}

export class InMemoryKeyStore implements KeyStore {
  private readonly keys = new Map<string, string>();

  get(name: string): string | null {
    return this.keys.get(name) ?? null;
  }

  set(name: string, key: string): void {
    this.keys.set(name, key);
  }

  delete(name: string): void {
    this.keys.delete(name);
  }
}
