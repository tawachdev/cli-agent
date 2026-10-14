import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BindingsStore } from "../src/engine/models/bindings";
import { parseToolArguments } from "../src/engine/models/types";
import { readJsonObject, writeJsonAtomic } from "../src/engine/shared/json-file";

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "mimon-json-"));
}

describe("config files survive corruption", () => {
  it("moves a corrupt file aside instead of reading it as empty", () => {
    const dir = scratch();
    const file = join(dir, "keys.json");
    writeFileSync(file, '{"openai": "sk-1", "anthr');
    expect(readJsonObject(file)).toEqual({});
    expect(existsSync(file)).toBe(false);
    const aside = readdirSync(dir).find((name) => name.startsWith("keys.json.corrupt-"))!;
    expect(readFileSync(join(dir, aside), "utf8")).toContain("sk-1");
    rmSync(dir, { recursive: true, force: true });
  });

  it("a write after corruption never destroys the original content", async () => {
    const dir = scratch();
    const file = join(dir, ".agent", "models.json");
    writeJsonAtomic(file, { coder: "openai/gpt-5" });
    writeFileSync(file, "{ not json");
    const store = new BindingsStore(dir, {}, { coder: "a", general: "a", mimon1: "a", mimon2: "a", mimon3: "a", mimonMax: "a" });
    await store.set("general", "anthropic/claude");
    expect(store.get("general")).toBe("anthropic/claude");
    const kept = readdirSync(join(dir, ".agent")).filter((name) => name.includes(".corrupt-"));
    expect(kept).toHaveLength(1);
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes atomically with the requested mode and leaves no temp files", () => {
    const dir = scratch();
    const file = join(dir, "keys.json");
    writeJsonAtomic(file, { a: "1" }, 0o600);
    expect(readJsonObject(file)).toEqual({ a: "1" });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir)).toEqual(["keys.json"]);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("parseToolArguments", () => {
  it("accepts objects and empty input, and flags everything else", () => {
    expect(parseToolArguments('{"path":"a"}')).toEqual({ arguments: { path: "a" } });
    expect(parseToolArguments("")).toEqual({ arguments: {} });
    expect(parseToolArguments('{"path":"a').argumentsError).toContain("not a valid JSON object");
    expect(parseToolArguments("[1,2]").argumentsError).toBeDefined();
    expect(parseToolArguments('"text"').argumentsError).toBeDefined();
  });
});
