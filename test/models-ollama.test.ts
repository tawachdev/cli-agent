import { describe, expect, it } from "bun:test";
import { OllamaProvider } from "../src/engine/models/provider";
import type { GenerateRequest, StreamChunk } from "../src/engine/models/types";

function startMockOllama(body: BodyInit): { url: string; stop: () => void } {
  const server = Bun.serve({
    port: 0,
    fetch: () =>
      new Response(body, {
        headers: { "content-type": "application/x-ndjson" },
      }),
  });
  return { url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}

function makeRequest(url: string): GenerateRequest {
  return {
    model: "fake-model",
    messages: [{ role: "user", content: "hi" }],
    numCtx: 4096,
  };
}

async function collect(iterable: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = [];
  for await (const chunk of iterable) {
    chunks.push(chunk);
  }
  return chunks;
}

describe("OllamaProvider", () => {
  it("parses token, tool_call, usage and done chunks from the NDJSON stream", async () => {
    const lines = [
      JSON.stringify({ message: { role: "assistant", content: "Hello" }, done: false }),
      JSON.stringify({ message: { role: "assistant", content: " world" }, done: false }),
      JSON.stringify({
        message: {
          role: "assistant",
          content: "",
          tool_calls: [{ function: { name: "fs.read", arguments: { path: "package.json" } } }],
        },
        done: false,
      }),
      JSON.stringify({
        message: { role: "assistant", content: "" },
        done: true,
        done_reason: "stop",
        prompt_eval_count: 10,
        eval_count: 5,
        eval_duration: 1e9,
        total_duration: 2e9,
      }),
    ];
    const mock = startMockOllama(new Blob(lines.map((line) => line + "\n")));
    const provider = new OllamaProvider(mock.url);
    const chunks = await collect(provider.complete(makeRequest(mock.url)));
    mock.stop();

    expect(chunks).toEqual([
      { type: "token", text: "Hello" },
      { type: "token", text: " world" },
      { type: "tool_call", call: { name: "fs.read", arguments: { path: "package.json" } } },
      {
        type: "usage",
        usage: {
          promptTokens: 10,
          completionTokens: 5,
          evalDurationNs: 1e9,
          totalDurationNs: 2e9,
        },
      },
      { type: "done", stopReason: "stop" },
    ]);
  });

  it("parses tool arguments delivered as a JSON string", async () => {
    const lines = [
      JSON.stringify({
        message: {
          role: "assistant",
          tool_calls: [{ function: { name: "fs.read", arguments: "{\"path\":\"a.txt\"}" } }],
        },
        done: false,
      }),
      JSON.stringify({ message: { role: "assistant", content: "" }, done: true, done_reason: "stop" }),
    ];
    const mock = startMockOllama(new Blob(lines.map((line) => line + "\n")));
    const provider = new OllamaProvider(mock.url);
    const chunks = await collect(provider.complete(makeRequest(mock.url)));
    mock.stop();

    const call = chunks.find((chunk) => chunk.type === "tool_call");
    expect(call).toEqual({ type: "tool_call", call: { name: "fs.read", arguments: { path: "a.txt" } } });
  });

  it("rejects with a readable error when Ollama is unreachable", async () => {
    const provider = new OllamaProvider("http://127.0.0.1:9");
    await expect(collect(provider.complete(makeRequest("http://127.0.0.1:9")))).rejects.toThrow(
      "Ollama unreachable",
    );
  });

  it("converts a text-JSON tool call into a tool_call chunk", async () => {
    const json = JSON.stringify({ name: "fs.read", arguments: { path: "package.json" } });
    const lines = [
      JSON.stringify({ message: { role: "assistant", content: json.slice(0, 10) }, done: false }),
      JSON.stringify({ message: { role: "assistant", content: json.slice(10) }, done: false }),
      JSON.stringify({ message: { role: "assistant", content: "" }, done: true, done_reason: "stop" }),
    ];
    const mock = startMockOllama(new Blob(lines.map((line) => line + "\n")));
    const provider = new OllamaProvider(mock.url);
    const chunks = await collect(provider.complete(makeRequest(mock.url)));
    mock.stop();

    expect(chunks).toEqual([
      { type: "tool_call", call: { name: "fs.read", arguments: { path: "package.json" } } },
      { type: "done", stopReason: "stop" },
    ]);
  });

  it("converts a tool_call-tagged Qwen text output into a tool_call chunk", async () => {
    const inner = JSON.stringify({ name: "fs.read", arguments: { path: "a.ts" } });
    const lines = [
      JSON.stringify({ message: { role: "assistant", content: "<tool_call>" }, done: false }),
      JSON.stringify({ message: { role: "assistant", content: inner }, done: false }),
      JSON.stringify({ message: { role: "assistant", content: "</tool_call>" }, done: false }),
      JSON.stringify({ message: { role: "assistant", content: "" }, done: true, done_reason: "stop" }),
    ];
    const mock = startMockOllama(new Blob(lines.map((line) => line + "\n")));
    const provider = new OllamaProvider(mock.url);
    const chunks = await collect(provider.complete(makeRequest(mock.url)));
    mock.stop();

    expect(chunks).toEqual([
      { type: "tool_call", call: { name: "fs.read", arguments: { path: "a.ts" } } },
      { type: "done", stopReason: "stop" },
    ]);
  });

  it("treats a JSON answer with a name field but no arguments as prose, not a tool call", async () => {
    const answer = JSON.stringify({ name: "agent", version: "0.1.0" });
    const lines = [
      JSON.stringify({ message: { role: "assistant", content: answer }, done: false }),
      JSON.stringify({ message: { role: "assistant", content: "" }, done: true, done_reason: "stop" }),
    ];
    const mock = startMockOllama(new Blob(lines.map((line) => line + "\n")));
    const provider = new OllamaProvider(mock.url);
    const chunks = await collect(provider.complete(makeRequest(mock.url)));
    mock.stop();

    expect(chunks).toEqual([
      { type: "token", text: answer },
      { type: "done", stopReason: "stop" },
    ]);
  });

  it("converts a fenced JSON tool call into a tool_call chunk", async () => {
    const inner = JSON.stringify({ name: "fs.read", arguments: { path: "b.ts" } });
    const lines = [
      JSON.stringify({ message: { role: "assistant", content: "```json" }, done: false }),
      JSON.stringify({ message: { role: "assistant", content: inner }, done: false }),
      JSON.stringify({ message: { role: "assistant", content: "```" }, done: false }),
      JSON.stringify({ message: { role: "assistant", content: "" }, done: true, done_reason: "stop" }),
    ];
    const mock = startMockOllama(new Blob(lines.map((line) => line + "\n")));
    const provider = new OllamaProvider(mock.url);
    const chunks = await collect(provider.complete(makeRequest(mock.url)));
    mock.stop();

    expect(chunks).toEqual([
      { type: "tool_call", call: { name: "fs.read", arguments: { path: "b.ts" } } },
      { type: "done", stopReason: "stop" },
    ]);
  });

  it("converts two concatenated text-JSON tool calls into two tool_call chunks", async () => {
    const one = JSON.stringify({ name: "shell.exec", arguments: { command: "ls" } });
    const two = JSON.stringify({ name: "fs.read", arguments: { path: "package.json" } });
    const lines = [
      JSON.stringify({ message: { role: "assistant", content: one + "\n\n" + two }, done: false }),
      JSON.stringify({ message: { role: "assistant", content: "" }, done: true, done_reason: "stop" }),
    ];
    const mock = startMockOllama(new Blob(lines.map((line) => line + "\n")));
    const provider = new OllamaProvider(mock.url);
    const chunks = await collect(provider.complete(makeRequest(mock.url)));
    mock.stop();

    expect(chunks).toEqual([
      { type: "tool_call", call: { name: "shell.exec", arguments: { command: "ls" } } },
      { type: "tool_call", call: { name: "fs.read", arguments: { path: "package.json" } } },
      { type: "done", stopReason: "stop" },
    ]);
  });

  it("stops streaming when the request is aborted", async () => {
    const slowBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            JSON.stringify({ message: { role: "assistant", content: "partial" }, done: false }) + "\n",
          ),
        );
      },
    });
    const mock = startMockOllama(slowBody);
    const provider = new OllamaProvider(mock.url);
    const controller = new AbortController();
    const iterator = provider.complete(makeRequest(mock.url), controller.signal)[Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(first.value).toEqual({ type: "token", text: "partial" });
    controller.abort();
    await expect(iterator.next()).rejects.toThrow();
    mock.stop();
  });

  it("retries without tools when the model does not support them", async () => {
    const bodies: Record<string, unknown>[] = [];
    let first = true;
    const server = Bun.serve({
      port: 0,
      fetch: async (request) => {
        bodies.push((await request.json()) as Record<string, unknown>);
        if (first) {
          first = false;
          return Response.json({ error: "registry.ollama.ai/library/qwen2.5vl:7b does not support tools" }, { status: 400 });
        }
        return new Response(
          JSON.stringify({ message: { role: "assistant", content: "a red square" }, done: false }) + "\n" +
          JSON.stringify({ message: { role: "assistant", content: "" }, done: true, done_reason: "stop" }) + "\n",
          { headers: { "content-type": "application/x-ndjson" } },
        );
      },
    });
    const provider = new OllamaProvider(`http://127.0.0.1:${server.port}`);
    const request: GenerateRequest = {
      ...makeRequest("x"),
      tools: [{ name: "fs.read", description: "read", parameters: {} }],
    };
    const chunks = await collect(provider.complete(request));
    server.stop();

    expect(chunks).toEqual([
      { type: "token", text: "a red square" },
      { type: "done", stopReason: "stop" },
    ]);
    expect(bodies).toHaveLength(2);
    expect("tools" in bodies[0]! && bodies[0]!["tools"] !== undefined).toBe(true);
    expect(bodies[1]!["tools"]).toBeUndefined();
  });
});
