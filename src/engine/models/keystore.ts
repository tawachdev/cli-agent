export interface KeyStore {
  get(name: string): string | null;
  set(name: string, key: string): void;
  delete(name: string): void;
}

const SERVICE = "agent";

export function envKeyName(name: string): string {
  return `AGENT_KEY_${name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
}

export class KeychainKeyStore implements KeyStore {
  get(name: string): string | null {
    const fromEnv = process.env[envKeyName(name)];
    if (fromEnv) return fromEnv;
    if (process.platform !== "darwin") return null;
    const run = Bun.spawnSync(["security", "find-generic-password", "-s", SERVICE, "-a", name, "-w"]);
    const key = run.stdout.toString().trim();
    return run.exitCode === 0 && key ? key : null;
  }

  set(name: string, key: string): void {
    if (process.platform !== "darwin") {
      throw new Error(`key storage needs macOS Keychain — set ${envKeyName(name)} instead`);
    }
    const run = Bun.spawnSync(["security", "add-generic-password", "-s", SERVICE, "-a", name, "-w", key, "-U"]);
    if (run.exitCode !== 0) {
      throw new Error(`could not store the key in Keychain (exit ${run.exitCode})`);
    }
  }

  delete(name: string): void {
    if (process.platform !== "darwin") {
      throw new Error(`key storage needs macOS Keychain — unset ${envKeyName(name)} instead`);
    }
    Bun.spawnSync(["security", "delete-generic-password", "-s", SERVICE, "-a", name]);
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
