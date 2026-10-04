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

function transcriptLine(message: ChatMessage): string {
  if (message.role === "tool") {
    const call = "toolCallId" in message ? ` (call ${message.toolCallId})` : "";
    return `tool[${message.toolName}]${call}: ` + message.content.slice(0, 2000);
  }
  if (message.role === "assistant") {
    const calls = message.toolCalls ?? [];
    const callText =
      calls.length > 0
        ? " [tool calls: " + calls.map((call) => `${call.name}(${JSON.stringify(call.arguments)})`).join("; ") + "]"
        : "";
    return "assistant: " + message.content.slice(0, 2000) + callText;
  }
  return message.role + ": " + message.content.slice(0, 2000);
}

export function estimateHistoryTokens(history: ChatMessage[]): number {
  return history.reduce(
    (sum, message) =>
      sum + Math.ceil(message.content.length / 4) + ("images" in message ? (message.images?.length ?? 0) * 1200 : 0),
    0,
  );
}

export function historyTokenBudget(numCtx: number): number {
  return Math.floor(numCtx * 0.7);
}

// A kept tail may not start with tool results whose assistant tool_calls turn was
// dropped — providers reject histories where a tool result has no matching call.
function trimOrphanedToolResults(messages: ChatMessage[]): ChatMessage[] {
  let start = 0;
  while (start < messages.length && messages[start]!.role === "tool") {
    start += 1;
  }
  return start === 0 ? messages : messages.slice(start);
}

export async function compactHistory(
  input: CompactionInput,
  history: ChatMessage[],
): Promise<{ history: ChatMessage[]; compacted: boolean }> {
  const budget = historyTokenBudget(input.numCtx);
  if (estimateHistoryTokens(history) <= budget) {
    return { history, compacted: false };
  }
  const keep = Math.min(6, Math.max(2, Math.floor((history.length - 2) / 2)));
  const oldMessages = history.slice(1, history.length - keep);
  const recent = history.slice(history.length - keep);
  const transcript = oldMessages.map(transcriptLine).join("\n");
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
  const summaryMessage: ChatMessage = { role: "user", content: "Conversation so far (summary): " + summary.trim() };
  let kept = trimOrphanedToolResults(recent);
  while (estimateHistoryTokens([history[0] as ChatMessage, summaryMessage, ...kept]) > budget && kept.length > 2) {
    kept = trimOrphanedToolResults(kept.slice(1));
  }
  const compacted: ChatMessage[] = [history[0] as ChatMessage, summaryMessage, ...kept];
  return { history: compacted, compacted: true };
}
