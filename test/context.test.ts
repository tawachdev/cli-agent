import { describe, expect, it } from "bun:test";
import { estimateTokens } from "../src/engine/core/context/budget";
import { compactHistory, estimateHistoryTokens, historyTokenBudget } from "../src/engine/core/context/compaction";
import { truncateObservation } from "../src/engine/core/context/truncation";
import { SessionStream } from "../src/engine/api/ws/agent-stream";
import type { ModelProvider, StreamChunk, GenerateRequest } from "../src/engine/models/types";

describe("context budget and truncation", () => {
  it("estimates tokens at roughly chars/4", () => {
    expect(estimateTokens("abcdefgh")).toBe(2);
    expect(estimateTokens("abc")).toBe(1);
  });

  it("keeps small observations and truncates big ones with head and tail", () => {
    const small = "tiny";
    expect(truncateObservation(small)).toBe("tiny");
    const big = "START_MARKER" + "x".repeat(40 * 1024);
    const truncated = truncateObservation(big, 12 * 1024);
    expect(truncated.length).toBeLessThan(big.length);
    expect(truncated).toContain("truncated");
    expect(truncated).toContain("START_MARKER");
  });
});

describe("history compaction", () => {
  it("skips compaction when the history fits the budget", async () => {
    const providerCalls: GenerateRequest[] = [];
    const provider: ModelProvider = {
      async *complete(req: GenerateRequest): AsyncGenerator<StreamChunk> {
        providerCalls.push(req);
        yield { type: "token", text: "should not be called" };
      },
    };
    const history = [
      { role: "system" as const, content: "system" },
      { role: "user" as const, content: "hi" },
    ];
    const events: string[] = [];
    const result = await compactHistory(
      {
        binding: { provider, model: "m" },
        numCtx: 16384,
        temperature: 0.2,
        publish: (type) => events.push(type),
      },
      history,
    );
    expect(result.compacted).toBe(false);
    expect(result.history).toBe(history);
    expect(providerCalls).toHaveLength(0);
    expect(events).toEqual([]);
  });

  it("summarizes old turns when the history exceeds the budget", async () => {
    const provider: ModelProvider = {
      async *complete(req: GenerateRequest): AsyncGenerator<StreamChunk> {
        expect(req.tools).toBeUndefined();
        yield { type: "token", text: "Task was to fill a repo with files." };
      },
    };
    const history = [
      { role: "system" as const, content: "system prompt" },
      ...Array.from({ length: 20 }, (_, i) => ({
        role: "user" as const,
        content: "turn " + i + " " + "x".repeat(2000),
      })),
      { role: "user" as const, content: "final question" },
    ];
    const events: string[] = [];
    const result = await compactHistory(
      {
        binding: { provider, model: "m" },
        numCtx: 4096,
        temperature: 0.2,
        publish: (type) => events.push(type),
      },
      history,
    );
    expect(result.compacted).toBe(true);
    expect(events).toEqual(["context.compacted"]);
    expect(estimateHistoryTokens(result.history)).toBeLessThan(estimateHistoryTokens(history));
    expect(result.history[0]?.role).toBe("system");
    expect(result.history[1]?.content).toContain("Conversation so far");
    expect(result.history.at(-1)?.content).toBe("final question");
    expect(estimateHistoryTokens(history)).toBeGreaterThan(historyTokenBudget(4096));
  });
});

describe("session stream replay", () => {
  it("replays buffered events after a given seq", () => {
    const stream = new SessionStream("s1");
    stream.publish("a", {});
    stream.publish("b", {});
    stream.publish("c", {});
    const seen: string[] = [];
    stream.subscribe((event) => seen.push(event.type + ":" + event.seq), 1);
    expect(seen).toEqual(["b:2", "c:3"]);
    stream.publish("d", {});
    expect(seen).toEqual(["b:2", "c:3", "d:4"]);
  });
});
