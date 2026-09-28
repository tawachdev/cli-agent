export type { ModelRole } from "../../shared/types";

export type ChatMessage =
  | { role: "system" | "user"; content: string; images?: string[] }
  | { role: "assistant"; content: string }
  | { role: "tool"; content: string; toolName: string };

export interface ToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  evalDurationNs: number;
  totalDurationNs: number;
}

export interface GenerateRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ToolSpec[];
  numCtx: number;
  temperature?: number;
}

export type StreamChunk =
  | { type: "token"; text: string }
  | { type: "tool_call"; call: ToolCall }
  | { type: "usage"; usage: TokenUsage }
  | { type: "done"; stopReason: string };

export interface ModelProvider {
  complete(req: GenerateRequest, signal?: AbortSignal): AsyncIterable<StreamChunk>;
}
