import { describe, expect, it } from "bun:test";
import { AnthropicProvider } from "../src/engine/models/anthropic-provider";
import type { ChatMessage, GenerateRequest, StreamChunk } from "../src/engine/models/types";

interface CapturedRequest {
  headers: Record<string, string>;
  body: unknown;
}

function startMockAnthropic(sse: string): { url: string; stop: () => void; requests: CapturedRequest[] } {
  const requests: CapturedRequest[] = [];
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      requests.push({
        headers: Object.fromEntries(request.headers.entries()),
        body: await request.json().catch(() => null),
      });
      return new Response(sse, { headers: { "content-type": "text/event-stream" } });
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true), requests };
}

const TOOL_USE_STREAM = [
  'data: {"type":"message_start","message":{"usage":{"input_tokens":21,"output_tokens":1}}}',
  'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}',
  'data: {"type":"content_block_stop","index":0}',
  'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_1","name":"fs.read","input":{}}}',
  'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":"}}',
  'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"\\"a.txt\\"}"}}',
  'data: {"type":"content_block_stop","index":1}',
  'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":9}}',
  'data: {"type":"message_stop"}',
].join("\n\n") + "\n\n";

const PLAIN_STREAM = 'data: {"type":"message_stop"}\n\n';

async function collect(iterable: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = [];
  for await (const chunk of iterable) {
    chunks.push(chunk);
  }
  return chunks;
}

function makeRequest(): GenerateRequest {
  return { model: "fake-model", messages: [{ role: "user", content: "hi" }], numCtx: 4096, temperature: 0.2 };
}

describe("AnthropicProvider", () => {
  it("streams tokens, tool_use blocks, usage and done", async () => {
    const mock = startMockAnthropic(TOOL_USE_STREAM);
    const provider = new AnthropicProvider(mock.url, "sk-ant-test", "anthropic");
    const chunks = await collect(provider.complete(makeRequest()));
    mock.stop();

    expect(chunks).toEqual([
      { type: "token", text: "Hello" },
      { type: "tool_call", call: { id: "toolu_1", name: "fs.read", arguments: { path: "a.txt" } } },
      {
        type: "usage",
        usage: { promptTokens: 21, completionTokens: 9, evalDurationNs: 0, totalDurationNs: 0 },
      },
      { type: "done", stopReason: "tool_calls" },
    ]);
  });

  it("sends x-api-key, anthropic version, max_tokens and input_schema tools", async () => {
    const mock = startMockAnthropic(PLAIN_STREAM);
    const provider = new AnthropicProvider(mock.url, "sk-ant-secret", "anthropic");
    await collect(
      provider.complete({
        model: "fake-model",
        messages: [{ role: "user", content: "hi" }],
        tools: [{ name: "fs.read", description: "read a file", parameters: { type: "object" } }],
        numCtx: 4096,
      }),
    );
    mock.stop();

    const request = mock.requests[0];
    expect(request?.headers["x-api-key"]).toBe("sk-ant-secret");
    expect(request?.headers["anthropic-version"]).toBe("2023-06-01");
    const body = (request?.body ?? {}) as Record<string, unknown>;
    expect(body["model"]).toBe("fake-model");
    expect(typeof body["max_tokens"]).toBe("number");
    expect(body["stream"]).toBe(true);
    expect(body["tools"]).toEqual([
      { name: "fs.read", description: "read a file", input_schema: { type: "object" } },
    ]);
  });

  it("moves system out, pairs tool results, merges consecutive user turns", async () => {
    const mock = startMockAnthropic(PLAIN_STREAM);
    const provider = new AnthropicProvider(mock.url, "sk-ant-test", "anthropic");
    const history: ChatMessage[] = [
      { role: "system", content: "be brief" },
      { role: "user", content: "hi" },
      { role: "assistant", content: "let me look" },
      { role: "tool", content: "{}", toolName: "fs.read" },
      { role: "tool", content: "[]", toolName: "fs.list" },
      { role: "user", content: "thanks" },
    ];
    await collect(provider.complete({ model: "m", messages: history, numCtx: 4096 }));
    mock.stop();

    const body = mock.requests[0]?.body as {
      system: string;
      messages: Array<{ role: string; content: unknown }>;
    };
    expect(body.system).toBe("be brief");
    expect(body.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "hi" }] },
      {
        role: "assistant",
        content: [
          { type: "text", text: "let me look" },
          { type: "tool_use", id: "mimon_tool_1", name: "fs.read", input: {} },
          { type: "tool_use", id: "mimon_tool_2", name: "fs.list", input: {} },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "mimon_tool_1", content: "{}" },
          { type: "tool_result", tool_use_id: "mimon_tool_2", content: "[]" },
          { type: "text", text: "thanks" },
        ],
      },
    ]);
  });

  it("sends user images as base64 source blocks", async () => {
    const mock = startMockAnthropic(PLAIN_STREAM);
    const provider = new AnthropicProvider(mock.url, "sk-ant-test", "anthropic");
    await collect(
      provider.complete({
        model: "m",
        messages: [{ role: "user", content: "what is this?", images: ["QUJD"] }],
        numCtx: 4096,
      }),
    );
    mock.stop();

    const body = mock.requests[0]?.body as {
      messages: Array<{ content: Array<Record<string, unknown>> }>;
    };
    expect(body.messages[0]?.content[1]).toEqual({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "QUJD" },
    });
  });

  it("surfaces provider errors with status and detail", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () => Response.json({ error: { message: "invalid api key" } }, { status: 401 }),
    });
    const provider = new AnthropicProvider(`http://127.0.0.1:${server.port}`, "sk-ant-bad", "anthropic");
    await expect(collect(provider.complete(makeRequest()))).rejects.toThrow("anthropic error 401");
    server.stop(true);
  });
});
