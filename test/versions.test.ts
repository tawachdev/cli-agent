import { describe, expect, it } from "bun:test";
import { currentVersion, SEMVER_RE, versionSites } from "../scripts/versions";

describe("product version", () => {
  it("is one semver everywhere it is written", () => {
    const version = currentVersion();
    expect(version).toMatch(SEMVER_RE);
    const drifted = versionSites().filter((site) => site.version !== version);
    expect(drifted).toEqual([]);
    expect(versionSites().length).toBeGreaterThanOrEqual(12);
  });
});
