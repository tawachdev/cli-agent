import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const PLATFORMS = ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"];
const MANIFESTS = ["package.json", "npm/main/package.json", "npm/main/package.local.json", ...PLATFORMS.map((p) => `npm/platforms/${p}/package.json`)];
const CONSTANT = "src/shared/version.ts";
const CONSTANT_RE = /export const PRODUCT_VERSION = "([^"]+)";/;

export const SEMVER_RE = /^\d+\.\d+\.\d+$/;

export interface VersionSite {
  file: string;
  where: string;
  version: string;
}

function readJson(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(ROOT, file), "utf8")) as Record<string, unknown>;
}

export function versionSites(): VersionSite[] {
  const sites: VersionSite[] = [];
  for (const file of MANIFESTS) {
    const manifest = readJson(file);
    sites.push({ file, where: "version", version: String(manifest["version"]) });
    const optional = (manifest["optionalDependencies"] ?? {}) as Record<string, string>;
    for (const [name, version] of Object.entries(optional)) {
      if (SEMVER_RE.test(version)) sites.push({ file, where: name, version });
    }
  }
  const constant = CONSTANT_RE.exec(readFileSync(join(ROOT, CONSTANT), "utf8"));
  sites.push({ file: CONSTANT, where: "PRODUCT_VERSION", version: constant?.[1] ?? "(missing)" });
  return sites;
}

export function currentVersion(): string {
  return String(readJson("package.json")["version"]);
}

export function writeVersion(version: string): void {
  for (const file of MANIFESTS) {
    const manifest = readJson(file);
    manifest["version"] = version;
    const optional = manifest["optionalDependencies"] as Record<string, string> | undefined;
    for (const [name, pinned] of Object.entries(optional ?? {})) {
      if (SEMVER_RE.test(pinned)) optional![name] = version;
    }
    writeFileSync(join(ROOT, file), JSON.stringify(manifest, null, 2) + "\n");
  }
  const path = join(ROOT, CONSTANT);
  writeFileSync(path, readFileSync(path, "utf8").replace(CONSTANT_RE, `export const PRODUCT_VERSION = "${version}";`));
}
