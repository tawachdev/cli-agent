import { z } from "zod";
import type { ToolSpec } from "../models/types";
import type { PermissionClass, ToolContext, ToolIds, ToolResult } from "./types";
import type { AnyTool } from "./types";

export interface ToolGate {
  authorize(
    cls: PermissionClass,
    target: string,
    ids: ToolIds,
    notify?: (request: { requestId: string; class: PermissionClass; target: string; preview?: string }) => void,
  ): Promise<{ granted: boolean }>;
}

export class ToolRegistry {
  private readonly tools = new Map<string, AnyTool>();

  constructor(private readonly gate?: ToolGate) {}

  register(tool: AnyTool): void {
    if (this.tools.has(tool.name)) {
      throw new Error("tool already registered: " + tool.name);
    }
    this.tools.set(tool.name, tool);
  }

  list(): AnyTool[] {
    return [...this.tools.values()];
  }

  specs(): ToolSpec[] {
    return this.list().map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: z.toJSONSchema(tool.schema) as Record<string, unknown>,
    }));
  }

  async invoke(
    name: string,
    rawArguments: Record<string, unknown>,
    ctx: ToolContext,
    ids: ToolIds = {},
    notify?: (request: { requestId: string; class: PermissionClass; target: string; preview?: string }) => void,
  ): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      return { ok: false, error: ["unknown tool", name].join(": ") };
    }
    const parsed = tool.schema.safeParse(rawArguments);
    if (!parsed.success) {
      return {
        ok: false,
        error: ["invalid arguments for", tool.name, parsed.error.message].join(": "),
      };
    }
    const target = tool.target(parsed.data);
    const preview = tool.preview?.(parsed.data);
    if (this.gate) {
      const decision = await this.gate.authorize(tool.permissionClass, target, ids, (request) =>
        notify?.({ ...request, preview }),
      );
      if (!decision.granted) {
        return {
          ok: false,
          error: ["permission denied by the permission engine for", tool.name, "on", target].join(" "),
        };
      }
    } else if (tool.permissionClass !== "read") {
      return { ok: false, error: "permission denied: no permission engine configured, read-only mode" };
    }
    return tool.invoke(parsed.data, ctx);
  }
}
