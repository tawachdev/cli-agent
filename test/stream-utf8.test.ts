import { describe, expect, it } from "bun:test";
import { AnthropicProvider } from "../src/engine/models/anthropic-provider";
import { OpenAICompatProvider } from "../src/engine/models/openai-provider";
import type { GenerateRequest, ModelProvider } from "../src/engine/models/types";

const TEXT = "h\u00e9llo \u{1F44B} \u65e5\u672c\u8a9e";

function byteByByteServer(sse: string): { url: string; stop: () => void } {
  const bytes = new TextEncoder().encode(sse);
  const server = Bun.serve({
    port: 0,
    fetch: () =>
      new Response(
        new ReadableStream({
          async pull(controller) {
            for (const byte of bytes) {
              controller.enqueue(new Uint8Array([byte]));
              await Bun.sleep(0);
            }
            controller.close();
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      ),
  });
  return { url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}

async function streamedText(provider: ModelProvider): Promise<string> {
  const request: GenerateRequest = { model: "m", messages: [{ role: "user", content: "hi" }], numCtx: 4096 };
  let text = "";
  for await (const chunk of provider.complete(request)) {
    if (chunk.type === "token") text += chunk.text;
  }
  return text;
}

describe("streaming keeps multi-byte characters split across network chunks", () => {
  it("openai-compatible", async () => {
    const server = byteByByteServer(
      `data: ${JSON.stringify({ choices: [{ delta: { content: TEXT } }] })}\n\ndata: [DONE]\n\n`,
    );
    try {
      expect(await streamedText(new OpenAICompatProvider(server.url, "sk-test", "fake"))).toBe(TEXT);
    } finally {
      server.stop();
    }
  });

  it("anthropic", async () => {
    const delta = { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: TEXT } };
    const server = byteByByteServer(
      `data: ${JSON.stringify(delta)}\n\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
    );
    try {
      expect(await streamedText(new AnthropicProvider(server.url, "sk-test", "fake"))).toBe(TEXT);
    } finally {
      server.stop();
    }
  });
});
