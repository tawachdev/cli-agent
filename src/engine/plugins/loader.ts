import { existsSync, readdirSync, readFileSync, statSync, realpathSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { z } from "zod";
import type { ToolRegistry } from "../tools/registry";
import type { AnyTool } from "../tools/types";
import type { Logger } from "../shared/logger";

const manifestSchema = z.object({
  name: z.string().min(1),
  version: z.string().min(1),
  entry: z
    .string()
    .default("index.ts")
    .refine((value) => !value.startsWith("/") && !value.includes(".."), {
      message: "plugin entry must be a relative path inside the plugin directory",
    }),
});

export type PluginManifest = z.infer<typeof manifestSchema>;

export type PluginTrust = "trusted" | "workspace";

export interface PluginRoot {
  dir: string;
  trust: PluginTrust;
}

export interface LoadedPlugin {
  name: string;
  version: string;
  tools: string[];
  trust: PluginTrust;
}

export async function loadPluginDir(
  pluginDir: string,
  registry: ToolRegistry,
  trust: PluginTrust = "trusted",
): Promise<LoadedPlugin> {
  const root = resolve(pluginDir);
  if (!statSync(root, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error("plugin directory not found: " + pluginDir);
  }
  const manifestPath = join(root, "manifest.json");
  if (!existsSync(manifestPath)) {
    throw new Error("plugin manifest not found: " + manifestPath);
  }
  const manifest = manifestSchema.parse(JSON.parse(readFileSync(manifestPath, "utf8")));
  const entryPath = resolve(root, manifest.entry);
  if (entryPath !== root && !entryPath.startsWith(root + sep)) {
    throw new Error("plugin entry escapes the plugin directory: " + manifest.entry);
  }
  if (!existsSync(entryPath)) {
    throw new Error("plugin entry not found: " + entryPath);
  }
  const realRoot = realpathSync(root);
  const realEntryDir = realpathSync(dirname(entryPath));
  if (realEntryDir !== realRoot && !realEntryDir.startsWith(realRoot + sep)) {
    throw new Error("plugin entry escapes the plugin directory through a symlink: " + manifest.entry);
  }
  const module = (await import(entryPath)) as { tools?: AnyTool[]; default?: AnyTool };
  const tools = module.tools ?? (module.default ? [module.default] : []);
  if (tools.length === 0) {
    throw new Error("plugin exports no tools: " + manifest.name);
  }
  const registered: string[] = [];
  for (const tool of tools) {
    registry.register(tool);
    registered.push(tool.name);
  }
  return { name: manifest.name, version: manifest.version, tools: registered, trust };
}

export interface LoadPluginRootsOptions {
  allowWorkspace?: boolean;
}

export async function loadPluginRoots(
  roots: Array<string | PluginRoot>,
  registry: ToolRegistry,
  logger?: Logger,
  options: LoadPluginRootsOptions = {},
): Promise<LoadedPlugin[]> {
  const loaded: LoadedPlugin[] = [];
  for (const entry of roots) {
    const root: PluginRoot = typeof entry === "string" ? { dir: entry, trust: "trusted" } : entry;
    if (!existsSync(root.dir)) continue;
    const present = readdirSync(root.dir, { withFileTypes: true }).some(
      (item) => item.isDirectory() && existsSync(join(root.dir, item.name, "manifest.json")),
    );
    if (present && root.trust === "workspace" && !options.allowWorkspace) {
      logger?.warn("workspace plugins found but disabled — plugins execute code; enable explicitly with AGENT_PLUGINS=workspace", {
        dir: root.dir,
      });
      continue;
    }
    for (const item of readdirSync(root.dir, { withFileTypes: true })) {
      if (!item.isDirectory()) continue;
      const pluginDir = join(root.dir, item.name);
      if (!existsSync(join(pluginDir, "manifest.json"))) continue;
      try {
        loaded.push(await loadPluginDir(pluginDir, registry, root.trust));
      } catch (error) {
        logger?.warn("plugin skipped", {
          dir: pluginDir,
          error: (error as Error).message,
        });
      }
    }
  }
  return loaded;
}
