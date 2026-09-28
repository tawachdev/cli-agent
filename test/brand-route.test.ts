import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrandStore } from "../src/engine/brand";
import { createBrandRoute } from "../src/engine/api/routes/brand";

function makeRoute(workspace: string, env: Record<string, string | undefined> = {}) {
  const rows: Array<{ type: string }> = [];
  const audit = { write: (type: string) => rows.push({ type }) } as never;
  const store = new BrandStore(workspace, env);
  return { route: createBrandRoute(store, audit), rows, store };
}

describe("brand store", () => {
  it("resolves effective brand: default, then env, then file", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brand-store-"));
    const store = new BrandStore(workspace, {});
    expect(store.effective()).toEqual({ name: "MIMON", colors: ["teal", "gold"], customColors: [], source: "default" });

    const envStore = new BrandStore(workspace, { AGENT_NAME: "anir", AGENT_COLORS: "purple,pink" });
    expect(envStore.effective()).toEqual({ name: "ANIR", colors: ["purple", "pink"], customColors: [], source: "env" });

    await store.write("sam", ["cyan", "orange"]);
    expect(store.effective()).toEqual({ name: "SAM", colors: ["cyan", "orange"], customColors: [], source: "file" });
    expect(envStore.effective()).toEqual({ name: "SAM", colors: ["cyan", "orange"], customColors: [], source: "file" });
    expect(new BrandStore(workspace, {}).effective().customColors).toEqual([]);
  });

  it("ignores corrupt or invalid brand.json and falls back", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brand-store-"));
    const store = new BrandStore(workspace, {});
    await Bun.write(join(workspace, ".agent", "brand.json"), "{ not json");
    expect(store.effective()).toEqual({ name: "MIMON", colors: ["teal", "gold"], customColors: [], source: "default" });
    await Bun.write(join(workspace, ".agent", "brand.json"), JSON.stringify({ name: "TOOLONGNAME16", colors: ["teal", "gold"] }));
    expect(store.effective().source).toBe("default");
  });

  it("applied hex colors join the user palette and survive restarts", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brand-store-"));
    const store = new BrandStore(workspace, {});
    await store.write("zeta", ["#ff5a00", "teal"]);
    await store.write("zeta", ["#00ff88"]);
    const saved = JSON.parse(readFileSync(join(workspace, ".agent", "brand.json"), "utf8")) as { customColors: string[] };
    expect(saved.customColors).toEqual(["#00ff88", "#ff5a00"]);
    const reopened = new BrandStore(workspace, {});
    expect(reopened.effective().customColors).toEqual(["#00ff88", "#ff5a00"]);
  });

  it("reset writes the defaults back to the file", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brand-store-"));
    const store = new BrandStore(workspace, {});
    await store.write("zeta", ["red", "blue"]);
    await store.reset();
    const saved = JSON.parse(readFileSync(join(workspace, ".agent", "brand.json"), "utf8"));
    expect(saved).toEqual({ name: "MIMON", colors: ["teal", "gold"], customColors: [] });
  });
});

describe("brand route", () => {
  it("returns defaults, applies name and colors, rejects invalid input", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brand-route-"));
    const { route, rows } = makeRoute(workspace);

    const before = (await (await route.request("/")).json()) as Record<string, unknown>;
    expect(before["name"]).toBe("MIMON");
    expect(before["source"]).toBe("default");
    expect(Array.isArray(before["palette"])).toBe(true);

    const bad = await route.request("/", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "nope way too long" }),
    });
    expect(bad.status).toBe(400);

    const badColor = await route.request("/", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ colors: ["rainbow", "gold"] }),
    });
    expect(badColor.status).toBe(400);

    const hex = await route.request("/", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ colors: ["#00FF88", "gold"] }),
    });
    const hexResult = (await hex.json()) as { ok: boolean; colors: string[] };
    expect(hexResult.ok).toBe(true);
    expect(hexResult.colors).toEqual(["#00ff88", "gold"]);

    const ok = await route.request("/", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "anir", colors: ["purple", "pink"] }),
    });
    const applied = (await ok.json()) as Record<string, unknown>;
    expect(applied["ok"]).toBe(true);
    expect(applied["name"]).toBe("ANIR");
    expect(applied["colors"]).toEqual(["purple", "pink"]);
    expect(existsSync(join(workspace, ".agent", "brand.json"))).toBe(true);

    const after = (await (await route.request("/")).json()) as Record<string, unknown>;
    expect(after["source"]).toBe("file");

    const reset = await route.request("/", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reset: true }),
    });
    const cleared = (await reset.json()) as Record<string, unknown>;
    expect(cleared["name"]).toBe("MIMON");
    expect(rows.map((r) => r.type)).toEqual(["brand.updated", "brand.updated", "brand.updated"]);
  });
});
