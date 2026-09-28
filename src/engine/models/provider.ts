import { stripDataUrl } from "../../shared/images";
import type {
  ChatMessage,
  GenerateRequest,
  ModelProvider,
  StreamChunk,
  ToolCall,
  ToolSpec,
} from "./types";

interface OllamaChatChunk {
  message?: {
    role?: string;
    content?: string;
    tool_calls?: Array<{
      function: { name: string; arguments: Record<string, unknown> | string };
    }>;
  };
  done?: boolean;
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
  eval_duration?: number;
  total_duration?: number;
}

function toOllamaMessage(message: ChatMessage) {
  if (message.role === "tool") {
    return { role: "tool", content: message.content, tool_name: message.toolName };
  }
  const base: Record<string, unknown> = { role: message.role, content: message.content };
  if (message.role === "user" && message.images && message.images.length > 0) {
    base["images"] = message.images.map(stripDataUrl);
  }
  return base;
}

function toOllamaTool(spec: ToolSpec) {
  return { type: "function", function: spec };
}

function toToolCall(raw: {
  function: { name: string; arguments: Record<string, unknown> | string };
}): ToolCall {
  const args =
    typeof raw.function.arguments === "string"
      ? (JSON.parse(raw.function.arguments) as Record<string, unknown>)
      : raw.function.arguments;
  return { name: raw.function.name, arguments: args };
}

function splitTopLevelJson(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (escaped) { escaped = false; continue; }
    if (ch === "\\") { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0 && start !== -1) {
        parts.push(text.slice(start, i + 1));
        start = -1;
      }
    }
  }
  return parts;
}

export class OllamaProvider implements ModelProvider {
  constructor(private readonly baseUrl: string) {}

  async *complete(req: GenerateRequest, signal?: AbortSignal): AsyncGenerator<StreamChunk> {
    const response = await this.request(req, signal);
    if (!response.body) {
      throw new Error(`Ollama returned an empty body (status ${response.status})`);
    }
    let buffer = "";
    let contentBuffer = "";
    let contentMode: "unknown" | "text" | "json" = "unknown";
    let endChunk: OllamaChatChunk | null = null;
    stream: for await (const piece of response.body) {
      buffer += new TextDecoder().decode(piece);
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) {
          const chunk = JSON.parse(line) as OllamaChatChunk;
          if (chunk.done) {
            endChunk = chunk;
            break stream;
          }
          yield* this.handleChunk(chunk);
          const content = chunk.message?.content;
          if (content) {
            contentBuffer += content;
            if (contentMode === "unknown") {
              const trimmed = contentBuffer.trimStart();
              if (trimmed.length === 0) continue;
              const fenced = trimmed.startsWith("```");
              contentMode =
                trimmed.startsWith("{") || trimmed.startsWith("<tool_call") || fenced ? "json" : "text";
              if (contentMode === "text") {
                yield { type: "token", text: contentBuffer };
              }
            } else if (contentMode === "text") {
              yield { type: "token", text: content };
            }
          }
        }
        newline = buffer.indexOf("\n");
      }
    }
    if (contentMode === "json") {
      yield* this.jsonToolCalls(contentBuffer);
    }
    if (endChunk) {
      yield* this.handleChunk(endChunk);
    }
  }

  private *jsonToolCalls(content: string): Generator<StreamChunk> {
    const stripped = content
      .replace(/<\/?tool_call>/g, "")
      .replace(/```(?:json)?/g, "")
      .trim();
    const emitted: StreamChunk[] = [];
    for (const candidate of splitTopLevelJson(stripped)) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(candidate);
      } catch {
        continue;
      }
      const items = Array.isArray(parsed) ? parsed : [parsed];
      for (const item of items) {
        const call = item as { name?: unknown; arguments?: unknown };
        if (typeof call.name !== "string") continue;
        let args: Record<string, unknown> = {};
        let hasArguments = false;
        if (typeof call.arguments === "string") {
          hasArguments = true;
          try {
            args = JSON.parse(call.arguments) as Record<string, unknown>;
          } catch {
            args = {};
          }
        } else if (typeof call.arguments === "object" && call.arguments !== null) {
          hasArguments = true;
          args = call.arguments as Record<string, unknown>;
        }
        if (hasArguments) {
          emitted.push({ type: "tool_call", call: { name: call.name, arguments: args } });
        }
      }
    }
    if (emitted.length > 0) {
      yield* emitted;
    } else {
      yield { type: "token", text: content };
    }
  }

  private async *handleChunk(chunk: OllamaChatChunk): AsyncGenerator<StreamChunk> {
    for (const raw of chunk.message?.tool_calls ?? []) {
      yield { type: "tool_call", call: toToolCall(raw) };
    }
    if (chunk.done) {
      if (typeof chunk.eval_count === "number") {
        yield {
          type: "usage",
          usage: {
            promptTokens: chunk.prompt_eval_count ?? 0,
            completionTokens: chunk.eval_count,
            evalDurationNs: chunk.eval_duration ?? 0,
            totalDurationNs: chunk.total_duration ?? 0,
          },
        };
      }
      yield { type: "done", stopReason: chunk.done_reason ?? "stop" };
    }
  }

  private async request(req: GenerateRequest, signal?: AbortSignal): Promise<Response> {
    let response = await this.post(req, signal);
    if (!response.ok && req.tools && req.tools.length > 0) {
      const detail = await response.text().catch(() => "");
      if (detail.includes("does not support tools")) {
        response = await this.post({ ...req, tools: undefined }, signal);
      } else {
        throw new Error(`Ollama error ${response.status}: ${detail.slice(0, 500)}`);
      }
    }
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(`Ollama error ${response.status}: ${detail.slice(0, 500)}`);
    }
    return response;
  }

  private async post(req: GenerateRequest, signal?: AbortSignal): Promise<Response> {
    try {
      return await fetch(`${this.baseUrl}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: req.model,
          messages: req.messages.map(toOllamaMessage),
          tools: req.tools?.map(toOllamaTool),
          stream: true,
          options: { num_ctx: req.numCtx, temperature: req.temperature ?? 0.2 },
        }),
        signal,
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new Error(`Ollama unreachable at ${this.baseUrl} - run \`ollama serve\``);
    }
  }
}
