import { describe, expect, it } from "bun:test";
import { cutChangelog, nextVersion } from "../scripts/release";

describe("nextVersion", () => {
  it("bumps by name or takes an explicit newer version", () => {
    expect(nextVersion("0.1.18", "patch")).toBe("0.1.19");
    expect(nextVersion("0.1.18", "minor")).toBe("0.2.0");
    expect(nextVersion("0.1.18", "major")).toBe("1.0.0");
    expect(nextVersion("0.1.18", "0.1.20")).toBe("0.1.20");
    expect(nextVersion("0.9.9", "0.10.0")).toBe("0.10.0");
  });

  it("refuses versions that are not newer or not x.y.z", () => {
    expect(() => nextVersion("0.1.18", "0.1.18")).toThrow("not newer");
    expect(() => nextVersion("0.1.18", "0.1.9")).toThrow("not newer");
    expect(() => nextVersion("0.1.18", "v0.2.0")).toThrow("expected");
  });
});

describe("cutChangelog", () => {
  const log = "# Changelog\n\n## Unreleased\n\n- new thing\n\n## 0.1.0 — 2026-01-01\n\n- first\n";

  it("moves the unreleased notes under a dated version and leaves Unreleased empty", () => {
    const cut = cutChangelog(log, "0.2.0", "2026-10-13");
    expect(cut).toBe("# Changelog\n\n## Unreleased\n\n## 0.2.0 — 2026-10-13\n\n- new thing\n\n## 0.1.0 — 2026-01-01\n\n- first\n");
  });

  it("refuses to release with nothing written under Unreleased", () => {
    const empty = cutChangelog(log, "0.2.0", "2026-10-13");
    expect(() => cutChangelog(empty, "0.3.0", "2026-10-14")).toThrow("nothing under");
  });
});
