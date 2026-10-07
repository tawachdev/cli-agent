import { sniffImageMime, toDataUrl } from "../../shared/images";
import type {
  ChatMessage,
  GenerateRequest,
  ModelProvider,
  StreamChunk,
  ToolCall,
  ToolSpec,
} from "./types";

interface OpenAIDelta {
  error?: { message?: string };
  choices?: Array<{
    delta?: {
      content?: string;
      tool_calls?: Array<{
        index: number;
        id?: string;
        extra_content?: { google?: { thought_signature?: string } };
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
}

interface PendingToolCall {
  id: string;
  name: string;
  arguments: string;
  signature: string;
}

interface OpenAIToolMessage {
  role: "tool";
  tool_call_id: string;
  content: string;
  [key: string]: unknown;
}

function toOpenAIMessages(messages: ChatMessage[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  // legacy fallback: tool results with no persisted call id are grouped under one
  // synthetic assistant tool_calls turn so old sessions still serialize legally
  const pendingResults: { id: string; name: string; content: string }[] = [];
  let callSeq = 0;
  const flushResults = () => {
    if (pendingResults.length === 0) return;
    out.push({
      role: "assistant",
      content: null,
      tool_calls: pendingResults.map((r) => ({
        id: r.id,
        type: "function",
        function: { name: r.name, arguments: "{}" },
      })),
    });
    for (const r of pendingResults) {
      out.push({ role: "tool", tool_call_id: r.id, content: r.content });
    }
    pendingResults.length = 0;
  };
  for (const message of messages) {
    if (message.role === "tool") {
      if (message.toolCallId) {
        flushResults();
        const toolMessage: OpenAIToolMessage = {
          role: "tool",
          tool_call_id: message.toolCallId,
          content: message.content,
        };
        out.push(toolMessage);
      } else {
        callSeq += 1;
        pendingResults.push({ id: `mimon_call_${callSeq}`, name: message.toolName, content: message.content });
      }
      continue;
    }
    flushResults();
    if (message.role === "assistant") {
      if (message.toolCalls && message.toolCalls.length > 0) {
        const content = message.content || null;
        out.push({
          role: "assistant",
          content,
          tool_calls: message.toolCalls.map((call) => ({
            id: call.id ?? `mimon_call_${call.name}`,
            type: "function",
            function: { name: call.name, arguments: JSON.stringify(call.arguments ?? {}) },
            ...(call.thoughtSignature
              ? { extra_content: { google: { thought_signature: call.thoughtSignature } } }
              : {}),
          })),
        });
      } else if (message.content) {
        out.push({ role: "assistant", content: message.content });
      }
      continue;
    }
    if (message.role === "user" && message.images && message.images.length > 0) {
      out.push({
        role: "user",
        content: [
          { type: "text", text: message.content },
          ...message.images.map((data) => ({
            type: "image_url",
            image_url: { url: toDataUrl(sniffImageMime(data) ?? "image/png", data) },
          })),
        ],
      });
      continue;
    }
    out.push({ role: message.role, content: message.content });
  }
  flushResults();
  return out;
}

function toToolCalls(pending: Map<number, PendingToolCall>): ToolCall[] {
  const calls: ToolCall[] = [];
  const indexes = [...pending.keys()].sort((a, b) => a - b);
  for (const index of indexes) {
    const pendingCall = pending.get(index) as PendingToolCall;
    let args: Record<string, unknown> = {};
    if (pendingCall.arguments) {
      try {
        args = JSON.parse(pendingCall.arguments) as Record<string, unknown>;
      } catch {
        args = {};
      }
    }
    calls.push({
      id: pendingCall.id,
      name: pendingCall.name,
      arguments: args,
      ...(pendingCall.signature ? { thoughtSignature: pendingCall.signature } : {}),
    });
  }
  return calls;
}

export class OpenAICompatProvider implements ModelProvider {
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
    const pending = new Map<number, PendingToolCall>();
    let stopReason = "stop";
    let usage: StreamChunk | null = null;
    let buffer = "";
    let streamDone = false;
    for await (const piece of response.body) {
      buffer += new TextDecoder().decode(piece);
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        const data = line.startsWith("data:") ? line.slice(5).trim() : "";
        if (data === "[DONE]") {
          streamDone = true;
          break;
        }
        if (data) {
          let chunk: OpenAIDelta;
          try {
            chunk = JSON.parse(data) as OpenAIDelta;
          } catch {
            newline = buffer.indexOf("\n");
            continue;
          }
          if (chunk.error) {
            throw new Error(`${this.label} stream error: ${chunk.error.message ?? "unknown"}`);
          }
          const choice = chunk.choices?.[0];
          const text = choice?.delta?.content;
          if (text) yield { type: "token", text };
          for (const fragment of choice?.delta?.tool_calls ?? []) {
            const existing = pending.get(fragment.index);
            if (existing) {
              if (fragment.id) existing.id = fragment.id;
              if (fragment.function?.name) existing.name = fragment.function.name;
              if (fragment.function?.arguments) existing.arguments += fragment.function.arguments;
              if (fragment.extra_content?.google?.thought_signature) {
                existing.signature = fragment.extra_content.google.thought_signature;
              }
            } else {
              pending.set(fragment.index, {
                id: fragment.id ?? `call_${fragment.index}`,
                name: fragment.function?.name ?? "",
                arguments: fragment.function?.arguments ?? "",
                signature: fragment.extra_content?.google?.thought_signature ?? "",
              });
            }
          }
          if (choice?.finish_reason) {
            stopReason = choice.finish_reason === "tool_calls" ? "tool_calls" : choice.finish_reason;
          }
          if (chunk.usage) {
            usage = {
              type: "usage",
              usage: {
                promptTokens: chunk.usage.prompt_tokens ?? 0,
                completionTokens: chunk.usage.completion_tokens ?? 0,
                evalDurationNs: 0,
                totalDurationNs: 0,
              },
            };
          }
        }
        newline = buffer.indexOf("\n");
      }
      if (streamDone) break;
    }
    for (const call of toToolCalls(pending)) {
      yield { type: "tool_call", call };
    }
    if (usage) yield usage;
    yield { type: "done", stopReason };
  }

  async listModels(): Promise<string[]> {
    const response = await fetch(`${this.baseUrl}/models`, {
      headers: { authorization: `Bearer ${this.apiKey}` },
    });
    if (!response.ok) {
      throw new Error(`${this.label} models error ${response.status}`);
    }
    const body = (await response.json()) as { data?: Array<{ id?: string }> };
    return [
      ...new Set(
        (body.data ?? [])
          .map((entry) => (entry.id ?? "").replace(/^models\//, ""))
          .filter((id) => id.length > 0),
      ),
    ].sort();
  }

  private async request(req: GenerateRequest, signal?: AbortSignal): Promise<Response> {
    let response: Response;
    const body: Record<string, unknown> = {
      model: req.model,
      messages: toOpenAIMessages(req.messages),
      stream: true,
      stream_options: { include_usage: true },
    };
    if (req.temperature !== undefined) body["temperature"] = req.temperature;
    if (req.tools && req.tools.length > 0) {
      body["tools"] = req.tools.map((spec: ToolSpec) => ({ type: "function", function: spec }));
    }
    try {
      response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.apiKey}`,
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
