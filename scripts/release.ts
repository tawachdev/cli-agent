import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { currentVersion, SEMVER_RE, writeVersion } from "./versions";

const ROOT = join(import.meta.dir, "..");
const CHANGELOG = join(ROOT, "CHANGELOG.md");
const UNRELEASED = "## Unreleased";

type Bump = "patch" | "minor" | "major";

export function nextVersion(current: string, requested: string): string {
  if (!SEMVER_RE.test(current)) throw new Error("current version is not x.y.z: " + current);
  const [major, minor, patch] = current.split(".").map(Number) as [number, number, number];
  const bumps: Record<Bump, string> = {
    patch: `${major}.${minor}.${patch + 1}`,
    minor: `${major}.${minor + 1}.0`,
    major: `${major + 1}.0.0`,
  };
  const next = bumps[requested as Bump] ?? requested;
  if (!SEMVER_RE.test(next)) throw new Error("expected patch, minor, major or x.y.z, got: " + requested);
  const order = (v: string) => v.split(".").map(Number).reduce((acc, part) => acc * 100_000 + part, 0);
  if (order(next) <= order(current)) throw new Error(`${next} is not newer than ${current}`);
  return next;
}

export function cutChangelog(text: string, version: string, date: string): string {
  const start = text.indexOf(UNRELEASED);
  if (start === -1) throw new Error("CHANGELOG.md has no '" + UNRELEASED + "' section");
  const bodyStart = start + UNRELEASED.length;
  const nextSection = text.indexOf("\n## ", bodyStart);
  const end = nextSection === -1 ? text.length : nextSection + 1;
  const notes = text.slice(bodyStart, end).trim();
  if (!notes) throw new Error("nothing under '" + UNRELEASED + "' — write what changed before releasing");
  return text.slice(0, start) + UNRELEASED + "\n\n## " + version + " — " + date + "\n\n" + notes + "\n\n" + text.slice(end);
}

function git(...args: string[]): string {
  const run = Bun.spawnSync(["git", ...args], { cwd: ROOT, stderr: "pipe" });
  if (run.exitCode !== 0) throw new Error("git " + args.join(" ") + " failed: " + run.stderr.toString().trim());
  return run.stdout.toString().trim();
}

function main(argv: string[]): void {
  const dryRun = argv.includes("--dry-run");
  const requested = argv.find((arg) => !arg.startsWith("--"));
  if (!requested) throw new Error("usage: bun run release patch|minor|major|x.y.z [--dry-run]");

  const current = currentVersion();
  const version = nextVersion(current, requested);
  const tag = "v" + version;
  if (git("status", "--porcelain")) throw new Error("the working tree has uncommitted changes");
  const branch = git("rev-parse", "--abbrev-ref", "HEAD");
  if (branch !== "main") throw new Error("releases are cut from main, not " + branch);
  if (git("tag", "--list", tag)) throw new Error(tag + " already exists");
  const changelog = cutChangelog(readFileSync(CHANGELOG, "utf8"), version, new Date().toISOString().slice(0, 10));

  console.log(`release ${current} → ${version}`);
  if (dryRun) {
    console.log("dry run: no files written");
    return;
  }
  writeVersion(version);
  writeFileSync(CHANGELOG, changelog);
  const gate = Bun.spawnSync(["bun", "run", "check"], { cwd: ROOT, stdout: "inherit", stderr: "inherit" });
  if (gate.exitCode !== 0) throw new Error("the gate failed — fix it, then `git checkout .` and run the release again");
  git("commit", "-am", "Release " + version);
  git("tag", "-a", tag, "-m", "Release " + version);
  console.log(`\ntagged ${tag}. publish it with:\n  git push origin main --follow-tags`);
}

if (import.meta.main) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error("release: " + (error as Error).message);
    process.exit(1);
  }
}
