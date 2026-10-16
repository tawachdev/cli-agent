import { describe, expect, it } from "bun:test";
import { createCompleteRoute } from "../src/engine/api/routes/complete";
import { ModelRouter } from "../src/engine/models/router";
import type { GenerateRequest, ModelProvider, StreamChunk } from "../src/engine/models/types";

function fakeProvider(chunks: StreamChunk[], seen: GenerateRequest[] = []): ModelProvider {
  return {
    async *complete(req) {
      seen.push(req);
      for (const chunk of chunks) yield chunk;
    },
  };
}

function routeWith(provider: ModelProvider) {
  const router = new ModelRouter(() => ({ provider, providerName: "fake", model: "tutor-1" }));
  return createCompleteRoute({ router, numCtx: 4096, temperature: 0.2 });
}

const validBody = {
  system: "You are a tutor.",
  messages: [{ role: "user", content: "Explain this line." }],
};

async function events(res: Response) {
  return (await res.text())
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

describe("POST /complete", () => {
  it("streams the model name, tokens, usage and done as NDJSON", async () => {
    const route = routeWith(
      fakeProvider([
        { type: "token", text: "Hel" },
        { type: "token", text: "lo" },
        { type: "usage", usage: { promptTokens: 10, completionTokens: 2, evalDurationNs: 0, totalDurationNs: 0 } },
        { type: "done", stopReason: "stop" },
      ]),
    );
    const res = await route.request("/", { method: "POST", body: JSON.stringify(validBody) });
    expect(res.headers.get("content-type")).toBe("application/x-ndjson");
    expect(await events(res)).toEqual([
      { type: "model", name: "fake/tutor-1" },
      { type: "token", text: "Hel" },
      { type: "token", text: "lo" },
      { type: "usage", usage: { promptTokens: 10, completionTokens: 2, evalDurationNs: 0, totalDurationNs: 0 } },
      { type: "done", stopReason: "stop" },
    ]);
  });

  it("never offers tools to the model and drops any tool call it emits", async () => {
    const seen: GenerateRequest[] = [];
    const route = routeWith(
      fakeProvider(
        [
          { type: "tool_call", call: { name: "fs.write", arguments: { path: "x" } } },
          { type: "done", stopReason: "stop" },
        ],
        seen,
      ),
    );
    const res = await route.request("/", { method: "POST", body: JSON.stringify(validBody) });
    const received = await events(res);
    expect(seen[0]?.tools).toBeUndefined();
    expect(seen[0]?.messages[0]).toEqual({ role: "system", content: "You are a tutor." });
    expect(received.some((event) => event.type === "tool_call")).toBe(false);
  });

  it("reports provider failures as an error event", async () => {
    const failing: ModelProvider = {
      async *complete() {
        throw new Error("rate limited");
      },
    };
    const res = await routeWith(failing).request("/", { method: "POST", body: JSON.stringify(validBody) });
    expect((await events(res)).at(-1)).toEqual({ type: "error", message: "rate limited" });
  });

  it("rejects bodies whose last message is not from the user", async () => {
    const route = routeWith(fakeProvider([]));
    const body = { ...validBody, messages: [{ role: "assistant", content: "hi" }] };
    const res = await route.request("/", { method: "POST", body: JSON.stringify(body) });
    expect(res.status).toBe(400);
  });

  it("rejects an oversized system prompt", async () => {
    const route = routeWith(fakeProvider([]));
    const body = { ...validBody, system: "x".repeat(16_001) };
    const res = await route.request("/", { method: "POST", body: JSON.stringify(body) });
    expect(res.status).toBe(400);
  });
});
