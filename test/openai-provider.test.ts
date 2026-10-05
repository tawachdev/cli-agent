import { describe, expect, it } from "bun:test";
import { OpenAICompatProvider } from "../src/engine/models/openai-provider";
import type { ChatMessage, GenerateRequest, StreamChunk } from "../src/engine/models/types";

interface CapturedRequest {
  headers: Record<string, string>;
  body: unknown;
}

function startMockOpenAI(sse: string): { url: string; stop: () => void; requests: CapturedRequest[] } {
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

const TOOL_CALL_STREAM = [
  'data: {"choices":[{"delta":{"role":"assistant","content":"Hel"}}]}',
  'data: {"choices":[{"delta":{"content":"lo"}}]}',
  'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","extra_content":{"google":{"thought_signature":"sig-abc"}},"function":{"name":"fs.read","arguments":""}}]}}]}',
  'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"path\\":"}}]}}]}',
  'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"a.txt\\"}"}}]}}]}',
  'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
  'data: {"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":7}}',
  "data: [DONE]",
].join("\n\n") + "\n\n";

const PLAIN_STREAM = 'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n';

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

describe("OpenAICompatProvider", () => {
  it("streams tokens, accumulated tool calls, usage and done", async () => {
    const mock = startMockOpenAI(TOOL_CALL_STREAM);
    const provider = new OpenAICompatProvider(mock.url, "sk-test", "fake");
    const chunks = await collect(provider.complete(makeRequest()));
    mock.stop();

    expect(chunks).toEqual([
      { type: "token", text: "Hel" },
      { type: "token", text: "lo" },
      { type: "tool_call", call: { id: "call_1", name: "fs.read", arguments: { path: "a.txt" }, thoughtSignature: "sig-abc" } },
      {
        type: "usage",
        usage: { promptTokens: 12, completionTokens: 7, evalDurationNs: 0, totalDurationNs: 0 },
      },
      { type: "done", stopReason: "tool_calls" },
    ]);
  });

  it("sends bearer auth, stream options and function tools", async () => {
    const mock = startMockOpenAI(PLAIN_STREAM);
    const provider = new OpenAICompatProvider(mock.url, "sk-secret", "fake");
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
    expect(request?.headers["authorization"]).toBe("Bearer sk-secret");
    expect(request?.headers["content-type"]).toBe("application/json");
    const body = (request?.body ?? {}) as Record<string, unknown>;
    expect(body["model"]).toBe("fake-model");
    expect(body["stream"]).toBe(true);
    expect(body["stream_options"]).toEqual({ include_usage: true });
    expect(body["tools"]).toEqual([
      { type: "function", function: { name: "fs.read", description: "read a file", parameters: { type: "object" } } },
    ]);
  });

  it("pairs tool results with a synthetic assistant tool_calls turn", async () => {
    const mock = startMockOpenAI(PLAIN_STREAM);
    const provider = new OpenAICompatProvider(mock.url, "sk-test", "fake");
    const history: ChatMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
      { role: "assistant", content: "let me look" },
      { role: "tool", content: "{}", toolName: "fs.read" },
      { role: "tool", content: "[]", toolName: "fs.list" },
    ];
    await collect(provider.complete({ model: "m", messages: history, numCtx: 4096 }));
    mock.stop();

    const body = mock.requests[0]?.body as { messages: Record<string, unknown>[] };
    expect(body.messages).toEqual([
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
      { role: "assistant", content: "let me look" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "mimon_call_1", type: "function", function: { name: "fs.read", arguments: "{}" } },
          { id: "mimon_call_2", type: "function", function: { name: "fs.list", arguments: "{}" } },
        ],
      },
      { role: "tool", tool_call_id: "mimon_call_1", content: "{}" },
      { role: "tool", tool_call_id: "mimon_call_2", content: "[]" },
    ]);
  });

  it("sends user images as data URLs", async () => {
    const mock = startMockOpenAI(PLAIN_STREAM);
    const provider = new OpenAICompatProvider(mock.url, "sk-test", "fake");
    await collect(
      provider.complete({
        model: "m",
        messages: [{ role: "user", content: "what is this?", images: ["QUJD"] }],
        numCtx: 4096,
      }),
    );
    mock.stop();

    const body = mock.requests[0]?.body as { messages: Array<{ content: unknown }> };
    expect(body.messages[0]?.content).toEqual([
      { type: "text", text: "what is this?" },
      { type: "image_url", image_url: { url: "data:image/png;base64,QUJD" } },
    ]);
  });

  it("surfaces provider errors with status and detail", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () => Response.json({ error: { message: "bad key" } }, { status: 401 }),
    });
    const provider = new OpenAICompatProvider(`http://127.0.0.1:${server.port}`, "sk-bad", "fake");
    await expect(collect(provider.complete(makeRequest()))).rejects.toThrow("fake error 401");
    server.stop(true);
  });

  it("stops streaming when the request is aborted", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'),
        );
      },
    });
    const server = Bun.serve({ port: 0, fetch: () => new Response(body, { status: 200 }) });
    const provider = new OpenAICompatProvider(`http://127.0.0.1:${server.port}`, "sk-test", "fake");
    const abort = new AbortController();
    const iterator = provider.complete(makeRequest(), abort.signal)[Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(first.value).toEqual({ type: "token", text: "partial" });
    abort.abort();
    await expect(iterator.next()).rejects.toThrow();
    server.stop(true);
  });
});
