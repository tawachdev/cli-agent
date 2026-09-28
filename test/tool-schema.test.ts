import { describe, expect, it } from "bun:test";
import { z } from "zod";
import { ToolRegistry } from "../src/engine/tools/registry";
import { fsReadTool } from "../src/engine/tools/fs/read";
import type { Tool } from "../src/engine/tools/types";

const writeSchema = z.object({ x: z.string() });
const writeTool: Tool<typeof writeSchema> = {
  name: "test.write",
  description: "write-tier tool used in tests",
  permissionClass: "write",
  schema: writeSchema,
  target: (input) => input.x,
  invoke: async () => ({ ok: true, data: null }),
};

describe("ToolRegistry", () => {
  it("converts Zod schemas to JSON Schema function specs", () => {
    const registry = new ToolRegistry();
    registry.register(fsReadTool);
    const [spec] = registry.specs();
    expect(spec?.name).toBe("fs.read");
    expect(spec?.parameters).toMatchObject({
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    });
  });

  it("rejects unknown tools, invalid arguments and non-read permission classes", async () => {
    const registry = new ToolRegistry();
    registry.register(fsReadTool);
    registry.register(writeTool);
    const ctx = { workspaceRoot: "/tmp" };

    const unknown = await registry.invoke("ghost.tool", {}, ctx);
    expect(unknown.ok).toBe(false);
    expect(unknown.ok === false && unknown.error).toContain("unknown tool");

    const invalid = await registry.invoke("fs.read", { path: 42 }, ctx);
    expect(invalid.ok).toBe(false);
    expect(invalid.ok === false && invalid.error).toContain("invalid arguments");

    const denied = await registry.invoke("test.write", { x: "1" }, ctx);
    expect(denied.ok).toBe(false);
    expect(denied.ok === false && denied.error).toContain("permission denied");
  });
});
