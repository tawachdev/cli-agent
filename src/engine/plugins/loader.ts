import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { ToolRegistry } from "../tools/registry";
import type { AnyTool } from "../tools/types";
import type { Logger } from "../shared/logger";

const manifestSchema = z.object({
  name: z.string().min(1),
  version: z.string().min(1),
  entry: z.string().default("index.ts"),
});

export type PluginManifest = z.infer<typeof manifestSchema>;

export interface LoadedPlugin {
  name: string;
  version: string;
  tools: string[];
}

export async function loadPluginDir(pluginDir: string, registry: ToolRegistry): Promise<LoadedPlugin> {
  const manifestPath = join(pluginDir, "manifest.json");
  if (!existsSync(manifestPath)) {
    throw new Error("plugin manifest not found: " + manifestPath);
  }
  const manifest = manifestSchema.parse(JSON.parse(readFileSync(manifestPath, "utf8")));
  const entryPath = join(pluginDir, manifest.entry);
  if (!existsSync(entryPath)) {
    throw new Error("plugin entry not found: " + entryPath);
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
  return { name: manifest.name, version: manifest.version, tools: registered };
}

export async function loadPluginRoots(
  roots: string[],
  registry: ToolRegistry,
  logger?: Logger,
): Promise<LoadedPlugin[]> {
  const loaded: LoadedPlugin[] = [];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const pluginDir = join(root, entry.name);
      if (!existsSync(join(pluginDir, "manifest.json"))) continue;
      try {
        loaded.push(await loadPluginDir(pluginDir, registry));
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
