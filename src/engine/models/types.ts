export type { ModelRole } from "../../shared/types";

export type ChatMessage =
  | { role: "system" | "user"; content: string; images?: string[] }
  | { role: "assistant"; content: string; toolCalls?: ToolCall[] }
  | { role: "tool"; content: string; toolName: string; toolCallId?: string };

export interface ToolCall {
  id?: string;
  name: string;
  arguments: Record<string, unknown>;
  argumentsError?: string;
  thoughtSignature?: string;
}

export function parseToolArguments(raw: string): Pick<ToolCall, "arguments" | "argumentsError"> {
  if (raw.trim() === "") return { arguments: {} };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return { arguments: parsed as Record<string, unknown> };
    }
  } catch {}
  return {
    arguments: {},
    argumentsError: "tool arguments were not a valid JSON object, the call was not run: " + raw.slice(0, 200),
  };
}

export interface PersistedToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  thoughtSignature?: string;
}

export function parseToolCalls(raw: string | null | undefined): PersistedToolCall[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is PersistedToolCall =>
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as PersistedToolCall).id === "string" &&
        typeof (entry as PersistedToolCall).name === "string" &&
        typeof (entry as PersistedToolCall).arguments === "object" &&
        (entry as PersistedToolCall).arguments !== null,
    );
  } catch {
    return [];
  }
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
  listModels?(): Promise<string[]>;
}
