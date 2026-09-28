import { describe, expect, it } from "bun:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { loadPluginDir, loadPluginRoots } from "../src/engine/plugins/loader";
import { ToolRegistry } from "../src/engine/tools/registry";
import type { Tool } from "../src/engine/tools/types";

const fixtureSchema = z.object({ x: z.string() });
const fixtureTool: Tool<typeof fixtureSchema> = {
  name: "plugin.echo",
  description: "test plugin tool",
  permissionClass: "read",
  schema: fixtureSchema,
  target: (input) => input.x,
  async invoke(input) {
    return { ok: true, data: { echoed: input.x } };
  },
};

describe("plugin loader", () => {
  it("loads a plugin from a directory with manifest and registers its tools", async () => {
    const root = await mkdtemp(join(tmpdir(), "plugins-"));
    const pluginDir = join(root, "echo-plugin");
    await mkdir(pluginDir, { recursive: true });
    await writeFile(
      join(pluginDir, "manifest.json"),
      JSON.stringify({ name: "echo-plugin", version: "1.0.0", entry: "index.ts" }),
    );
    await writeFile(join(pluginDir, "index.ts"), "export { fixtureTool as default } from '../fixtures/echo';\n");
    const fixtures = join(root, "fixtures");
    await mkdir(fixtures, { recursive: true });
    await writeFile(
      join(fixtures, "echo.ts"),
      "const s = {\n" +
        "  safeParse: (input: unknown) =>\n" +
        "    typeof input === 'object' && input !== null && 'x' in input\n" +
        "      ? { success: true, data: input }\n" +
        "      : { success: false, error: { message: 'x required' } },\n" +
        "};\n" +
        "export const fixtureTool = {\n" +
        "  name: 'plugin.echo', description: 'echo', permissionClass: 'read', schema: s,\n" +
        "  target: (i: { x: string }) => i.x,\n" +
        "  invoke: async (i: { x: string }) => ({ ok: true, data: { echoed: i.x } }),\n" +
        "};\n",
    );

    const registry = new ToolRegistry();
    const loaded = await loadPluginDir(pluginDir, registry);
    expect(loaded.name).toBe("echo-plugin");
    expect(loaded.tools).toEqual(["plugin.echo"]);
    const result = await registry.invoke("plugin.echo", { x: "hi" }, { workspaceRoot: root });
    expect(result).toEqual({ ok: true, data: { echoed: "hi" } });

    const roots = await loadPluginRoots([root], new ToolRegistry());
    expect(roots).toHaveLength(1);
    expect(roots[0]?.tools).toEqual(["plugin.echo"]);
  });

  it("rejects a plugin directory without a manifest", async () => {
    const root = await mkdtemp(join(tmpdir(), "plugins-"));
    await expect(loadPluginDir(root, new ToolRegistry())).rejects.toThrow("manifest not found");
  });
});
