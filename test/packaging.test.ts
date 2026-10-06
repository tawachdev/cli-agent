import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

const PLATFORMS = ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"];

describe("packaging consistency", () => {
  const root = readJson("package.json");
  const main = readJson("npm/main/package.json");
  const local = readJson("npm/main/package.local.json");
  const wrapper = readFileSync("npm/main/bin/mimon.js", "utf8");
  const installer = readFileSync("install.sh", "utf8");

  it("keeps one version across the release system", () => {
    const version = root["version"];
    expect(main["version"]).toBe(version);
    expect(local["version"]).toBe(version);
    for (const platform of PLATFORMS) {
      const manifest = readJson(`npm/platforms/${platform}/package.json`);
      expect(manifest["version"]).toBe(version);
    }
  });

  it("wires main optionalDependencies to the real platform packages", () => {
    const deps = main["optionalDependencies"] as Record<string, string>;
    for (const platform of PLATFORMS) {
      const manifest = readJson(`npm/platforms/${platform}/package.json`);
      expect(deps[`@mohamed-taaouch/${platform}`]).toBe(manifest["version"] as string);
    }
  });

  it("leaves no obsolete package scopes anywhere", () => {
    expect(wrapper).not.toContain("@tawachdev");
    expect(wrapper).toContain("@mohamed-taaouch/");
    expect(wrapper).toContain("npm i -g mimon");
    expect(local["optionalDependencies"]).toMatchObject({
      "@mohamed-taaouch/darwin-arm64": "file:../platforms/darwin-arm64",
    });
    for (const platform of PLATFORMS) {
      const readme = readFileSync(`npm/platforms/${platform}/README.md`, "utf8");
      expect(readme).toContain(`@mohamed-taaouch/${platform}`);
      expect(readme).not.toContain("@mimon/");
    }
  });

  it("publishes every package as MIT", () => {
    expect(main["license"]).toBe("MIT");
    expect(local["license"]).toBe("MIT");
    for (const platform of PLATFORMS) {
      const manifest = readJson(`npm/platforms/${platform}/package.json`);
      expect(manifest["license"]).toBe("MIT");
    }
  });

  it("never installs an unverified binary from install.sh", () => {
    expect(installer).toContain("checksum file missing");
    expect(installer).toContain("cannot verify the download, aborting");
    expect(installer).not.toContain(".sha256\" -o \"$TMP_DIR/$ASSET.sha256\" || true");
  });
});
