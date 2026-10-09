import { describe, expect, it } from "bun:test";
import { compactHistory, estimateHistoryTokens } from "../src/engine/core/context/compaction";
import type { ModelProvider, StreamChunk } from "../src/engine/models/types";

describe("compaction progress", () => {
  it("shrinks an 8-message history that exceeds the budget", async () => {
    const provider: ModelProvider = {
      async *complete(): AsyncGenerator<StreamChunk> {
        yield { type: "token", text: "S" };
      },
    };
    const history = [
      { role: "system" as const, content: "system prompt" },
      ...Array.from({ length: 7 }, (_, i) => ({
        role: "user" as const,
        content: "message " + i + " " + "x".repeat(500),
      })),
    ];
    const result = await compactHistory(
      {
        binding: { provider, providerName: "fake", model: "m" },
        numCtx: 512,
        temperature: 0.2,
        publish: () => {},
      },
      history,
    );
    expect(result.compacted).toBe(true);
    expect(result.history.length).toBeLessThan(history.length);
    expect(estimateHistoryTokens(result.history)).toBeLessThan(estimateHistoryTokens(history));
    expect(result.history[0]?.role).toBe("system");
    expect(result.history.at(-1)?.content).toContain("message 6");
  });
});
