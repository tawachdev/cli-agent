import type { z } from "zod";

export type PermissionClass = "read" | "write" | "exec" | "destructive";

export type ToolResult = { ok: true; data: unknown } | { ok: false; error: string; data?: unknown };

export interface ToolContext {
  workspaceRoot: string;
  signal?: AbortSignal;
}

export interface ToolIds {
  sessionId?: string;
  taskId?: string;
}

export interface Tool<T extends z.ZodObject<z.ZodRawShape> = z.ZodObject<z.ZodRawShape>> {
  name: string;
  description: string;
  permissionClass: PermissionClass;
  schema: T;
  target(input: z.output<T>): string;
  preview?(input: z.output<T>): string;
  invoke(input: z.output<T>, ctx: ToolContext): Promise<ToolResult>;
}

export type AnyTool = Tool<z.ZodObject<z.ZodRawShape>>;
