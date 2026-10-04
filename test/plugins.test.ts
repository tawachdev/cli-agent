import { describe, expect, it } from "bun:test";
import { mkdtemp, mkdir, writeFile, symlink } from "node:fs/promises";
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


describe("plugin trust boundary", () => {
  const TOOL_SOURCE =
    "const schema = { safeParse: (i) => typeof i === 'object' && i !== null\n" +
    "  ? { success: true, data: i }\n" +
    "  : { success: false, error: { message: 'x' } } };\n" +
    "export const tools = [{ name: 'ws.tool', description: 'x', permissionClass: 'read',\n" +
    "  schema, target: () => 'x', invoke: async () => ({ ok: true, data: {} }) }];\n";

  async function makeWorkspacePlugin(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "plugins-ws-"));
    const pluginDir = join(root, "ws-plugin");
    await mkdir(pluginDir, { recursive: true });
    await writeFile(
      join(pluginDir, "manifest.json"),
      JSON.stringify({ name: "ws-plugin", version: "1.0.0" }),
    );
    await writeFile(join(pluginDir, "index.ts"), TOOL_SOURCE);
    return root;
  }

  it("skips workspace plugin roots unless explicitly enabled", async () => {
    const root = await makeWorkspacePlugin();
    const disabled = await loadPluginRoots([{ dir: root, trust: "workspace" }], new ToolRegistry());
    expect(disabled).toEqual([]);

    const enabled = await loadPluginRoots([{ dir: root, trust: "workspace" }], new ToolRegistry(), undefined, {
      allowWorkspace: true,
    });
    expect(enabled).toHaveLength(1);
    expect(enabled[0]?.trust).toBe("workspace");
  });

  it("still loads trusted roots by default", async () => {
    const root = await makeWorkspacePlugin();
    const loaded = await loadPluginRoots([{ dir: root, trust: "trusted" }], new ToolRegistry());
    expect(loaded).toHaveLength(1);
  });

  it("rejects manifest entries that escape the plugin directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "plugins-escape-"));
    const pluginDir = join(root, "evil");
    await mkdir(pluginDir, { recursive: true });
    await writeFile(
      join(pluginDir, "manifest.json"),
      JSON.stringify({ name: "evil", version: "1.0.0", entry: "../../outside.ts" }),
    );
    await writeFile(join(root, "outside.ts"), TOOL_SOURCE);
    await expect(loadPluginDir(pluginDir, new ToolRegistry())).rejects.toThrow(/plugin entry/);
  });

  it("rejects entries that escape through a symlinked directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "plugins-link-"));
    const outside = await mkdtemp(join(tmpdir(), "plugins-out-"));
    const pluginDir = join(root, "evil");
    await mkdir(pluginDir, { recursive: true });
    await writeFile(
      join(pluginDir, "manifest.json"),
      JSON.stringify({ name: "evil", version: "1.0.0", entry: "link/evil.ts" }),
    );
    await writeFile(join(outside, "evil.ts"), TOOL_SOURCE);
    await symlink(outside, join(pluginDir, "link"));
    await expect(loadPluginDir(pluginDir, new ToolRegistry())).rejects.toThrow(/through a symlink/);
  });
});

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
