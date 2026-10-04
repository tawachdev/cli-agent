import { sniffImageMime } from "../../shared/images";
import type {
  ChatMessage,
  GenerateRequest,
  ModelProvider,
  StreamChunk,
  ToolCall,
} from "./types";

interface AnthropicEvent {
  type: string;
  message?: { usage?: { input_tokens?: number } };
  content_block?: { type: string; id?: string; name?: string };
  index?: number;
  delta?: { type?: string; text?: string; partial_json?: string; stop_reason?: string };
  usage?: { output_tokens?: number };
}

interface PendingToolUse {
  id: string;
  name: string;
  arguments: string;
}

type Block = Record<string, unknown>;

const MAX_TOKENS = 8192;

function toAnthropicMessages(messages: ChatMessage[]): { system: string; messages: Block[] } {
  const system: string[] = [];
  const out: Block[] = [];
  // legacy fallback: tool results with no persisted call id are re-attached with
  // synthetic ids so old sessions still serialize legally
  const pendingResults: { id: string; name: string; content: string }[] = [];
  let callSeq = 0;
  const flushResults = () => {
    if (pendingResults.length === 0) return;
    const toolUse = pendingResults.map((r) => ({ type: "tool_use", id: r.id, name: r.name, input: {} }));
    const last = out[out.length - 1];
    if (last && last["role"] === "assistant") {
      (last["content"] as Block[]).push(...toolUse);
    } else {
      out.push({ role: "assistant", content: toolUse });
    }
    out.push({
      role: "user",
      content: pendingResults.map((r) => ({ type: "tool_result", tool_use_id: r.id, content: r.content })),
    });
    pendingResults.length = 0;
  };
  const pushUser = (blocks: Block[]) => {
    const last = out[out.length - 1];
    if (last && last["role"] === "user") {
      (last["content"] as Block[]).push(...blocks);
    } else {
      out.push({ role: "user", content: blocks });
    }
  };
  for (const message of messages) {
    if (message.role === "system") {
      system.push(message.content);
      continue;
    }
    if (message.role === "tool") {
      if (message.toolCallId) {
        // canonical path: results group into the user turn that follows the assistant tool_use turn
        const last = out[out.length - 1];
        const toolResult: Block = { type: "tool_result", tool_use_id: message.toolCallId, content: message.content };
        if (last && last["role"] === "user" && Array.isArray(last["content"]) && (last["content"] as Block[]).every((b) => b["type"] === "tool_result")) {
          (last["content"] as Block[]).push(toolResult);
        } else {
          flushResults();
          out.push({ role: "user", content: [toolResult] });
        }
      } else {
        callSeq += 1;
        pendingResults.push({ id: `mimon_tool_${callSeq}`, name: message.toolName, content: message.content });
      }
      continue;
    }
    flushResults();
    if (message.role === "assistant") {
      const blocks: Block[] = [];
      if (message.content) blocks.push({ type: "text", text: message.content });
      for (const call of message.toolCalls ?? []) {
        blocks.push({ type: "tool_use", id: call.id ?? `mimon_tool_${call.name}`, name: call.name, input: call.arguments ?? {} });
      }
      if (blocks.length > 0) out.push({ role: "assistant", content: blocks });
      continue;
    }
    const blocks: Block[] = [{ type: "text", text: message.content }];
    for (const image of message.images ?? []) {
      blocks.push({ type: "image", source: { type: "base64", media_type: sniffImageMime(image) ?? "image/png", data: image } });
    }
    pushUser(blocks);
  }
  flushResults();
  if (out[0] && out[0]["role"] === "assistant") {
    out.unshift({ role: "user", content: [{ type: "text", text: "(earlier context omitted)" }] });
  }
  return { system: system.join("\n\n"), messages: out };
}

const STOP_REASONS: Record<string, string> = {
  end_turn: "stop",
  stop_sequence: "stop",
  max_tokens: "max_tokens",
  tool_use: "tool_calls",
};

export class AnthropicProvider implements ModelProvider {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly label: string,
  ) {}

  async *complete(req: GenerateRequest, signal?: AbortSignal): AsyncGenerator<StreamChunk> {
    const response = await this.request(req, signal);
    if (!response.body) {
      throw new Error(`${this.label} returned an empty body (status ${response.status})`);
    }
    const blocks = new Map<number, PendingToolUse>();
    let promptTokens = 0;
    let completionTokens = 0;
    let stopReason = "stop";
    let buffer = "";
    for await (const piece of response.body) {
      buffer += new TextDecoder().decode(piece);
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line.startsWith("data:")) {
          let event: AnthropicEvent;
          try {
            event = JSON.parse(line.slice(5).trim()) as AnthropicEvent;
          } catch {
            newline = buffer.indexOf("\n");
            continue;
          }
          if (event.type === "error") {
            const err = (event as { error?: { message?: string } }).error;
            throw new Error(`${this.label} stream error: ${err?.message ?? "unknown"}`);
          }
          if (event.type === "message_start") {
            promptTokens = event.message?.usage?.input_tokens ?? 0;
          } else if (event.type === "content_block_start" && event.content_block?.type === "tool_use") {
            blocks.set(event.index ?? 0, {
              id: event.content_block.id ?? "",
              name: event.content_block.name ?? "",
              arguments: "",
            });
          } else if (event.type === "content_block_delta") {
            if (event.delta?.type === "text_delta" && event.delta.text) {
              yield { type: "token", text: event.delta.text };
            } else if (event.delta?.type === "input_json_delta") {
              const block = blocks.get(event.index ?? 0);
              if (block && event.delta.partial_json) block.arguments += event.delta.partial_json;
            }
          } else if (event.type === "content_block_stop") {
            const block = blocks.get(event.index ?? 0);
            if (block) {
              let args: Record<string, unknown> = {};
              if (block.arguments) {
                try {
                  args = JSON.parse(block.arguments) as Record<string, unknown>;
                } catch {
                  args = {};
                }
              }
              const call: ToolCall = { id: block.id || undefined, name: block.name, arguments: args };
              yield { type: "tool_call", call };
              blocks.delete(event.index ?? 0);
            }
          } else if (event.type === "message_delta") {
            completionTokens = event.usage?.output_tokens ?? completionTokens;
            if (event.delta?.stop_reason) stopReason = STOP_REASONS[event.delta.stop_reason] ?? "stop";
          }
        }
        newline = buffer.indexOf("\n");
      }
    }
    yield {
      type: "usage",
      usage: {
        promptTokens,
        completionTokens,
        evalDurationNs: 0,
        totalDurationNs: 0,
      },
    };
    yield { type: "done", stopReason };
  }

  private async request(req: GenerateRequest, signal?: AbortSignal): Promise<Response> {
    const { system, messages } = toAnthropicMessages(req.messages);
    const body: Record<string, unknown> = {
      model: req.model,
      max_tokens: MAX_TOKENS,
      messages,
      stream: true,
    };
    if (system) body["system"] = system;
    if (req.temperature !== undefined) body["temperature"] = req.temperature;
    if (req.tools && req.tools.length > 0) {
      body["tools"] = req.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.parameters,
      }));
    }
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": this.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(body),
        signal,
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new Error(`${this.label} unreachable at ${this.baseUrl}`);
    }
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(`${this.label} error ${response.status}: ${detail.slice(0, 500)}`);
    }
    return response;
  }
}
