import type { ChatMessage } from "../../models/types";
import type { ModelBinding } from "../../models/router";
import type { PublishEvent } from "../agent/loop";

const SUMMARY_PROMPT =
  "Summarize the conversation so far into a compact state block: the task, the plan, what was done, key facts discovered, and what remains. Keep file paths and exact findings. Max 200 words.";

export interface CompactionInput {
  binding: ModelBinding;
  numCtx: number;
  temperature: number;
  signal?: AbortSignal;
  publish: PublishEvent;
}

export function estimateHistoryTokens(history: ChatMessage[]): number {
  return history.reduce((sum, message) => sum + Math.ceil(message.content.length / 4), 0);
}

export function historyTokenBudget(numCtx: number): number {
  return Math.floor(numCtx * 0.7);
}

export async function compactHistory(
  input: CompactionInput,
  history: ChatMessage[],
): Promise<{ history: ChatMessage[]; compacted: boolean }> {
  const budget = historyTokenBudget(input.numCtx);
  if (estimateHistoryTokens(history) <= budget) {
    return { history, compacted: false };
  }
  const keep = Math.min(6, Math.max(2, history.length - 2));
  const oldMessages = history.slice(1, history.length - keep);
  const recent = history.slice(history.length - keep);
  const transcript = oldMessages
    .map((message) => message.role + ": " + message.content.slice(0, 2000))
    .join("\n");
  let summary = "";
  for await (const chunk of input.binding.provider.complete(
    {
      model: input.binding.model,
      messages: [
        { role: "system", content: SUMMARY_PROMPT },
        { role: "user", content: transcript },
      ],
      numCtx: input.numCtx,
      temperature: input.temperature,
    },
    input.signal,
  )) {
    if (chunk.type === "token") {
      summary += chunk.text;
    }
  }
  input.publish("context.compacted", { summarizedTurns: oldMessages.length });
  const compacted: ChatMessage[] = [
    history[0] as ChatMessage,
    { role: "user", content: "Conversation so far (summary): " + summary.trim() },
    ...recent,
  ];
  return { history: compacted, compacted: true };
}
