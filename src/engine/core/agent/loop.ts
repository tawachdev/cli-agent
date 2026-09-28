import type { Db } from "../../db/client";
import type { ModelBinding } from "../../models/router";
import type { ChatMessage, TokenUsage, ToolCall } from "../../models/types";
import { compactHistory } from "../context/compaction";
import { truncateObservation } from "../context/truncation";
import type { ToolRegistry } from "../../tools/registry";
import { appendMessage, listMessages } from "./state";

export type PublishEvent = (type: string, payload: unknown) => void;

export interface TurnDeps {
  db: Db;
  binding: ModelBinding;
  tools: ToolRegistry;
  toolContext: { workspaceRoot: string; signal?: AbortSignal };
  publish: PublishEvent;
  numCtx: number;
  temperature?: number;
  maxSteps?: number;
  sessionId: string;
  taskId: string;
  signal?: AbortSignal;
}

export interface TurnResult {
  answer: string;
  steps: number;
  usage: TokenUsage | null;
}

const SYSTEM_PROMPT =
  "You are Mimon, a personal coding agent running fully local on this machine (never claim to be another assistant or model). Use the provided tools to gather information before answering questions about the workspace. After using tools, give your final answer in plain prose. Be concise and factual.";

export async function runTurn(deps: TurnDeps, task: string, images: string[] = []): Promise<TurnResult> {
  const maxSteps = deps.maxSteps ?? 6;
  deps.publish("turn.started", { task });
  appendMessage(deps.db, { sessionId: deps.sessionId, role: "user", content: task });

  const history: ChatMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    ...listMessages(deps.db, deps.sessionId).map(toChatMessage),
  ];
  if (images.length > 0) attachImages(history, images);
  const specs = deps.tools.specs();
  let workingHistory = history;
  let answer = "";
  let usage: TokenUsage | null = null;
  const ids = { sessionId: deps.sessionId, taskId: deps.taskId };

  for (let step = 1; step <= maxSteps; step++) {
    const compacted = await compactHistory(
      {
        binding: deps.binding,
        numCtx: deps.numCtx,
        temperature: deps.temperature ?? 0.2,
        signal: deps.signal,
        publish: deps.publish,
      },
      workingHistory,
    );
    workingHistory = compacted.history;
    const turnCalls: ToolCall[] = [];
    let turnContent = "";
    for await (const chunk of deps.binding.provider.complete(
      {
        model: deps.binding.model,
        messages: workingHistory,
        tools: specs,
        numCtx: deps.numCtx,
        temperature: deps.temperature,
      },
      deps.signal,
    )) {
      if (chunk.type === "token") {
        turnContent += chunk.text;
        deps.publish("token.delta", { text: chunk.text });
      } else if (chunk.type === "tool_call") {
        turnCalls.push(chunk.call);
      } else if (chunk.type === "usage") {
        usage = chunk.usage;
        deps.publish("usage", chunk.usage);
      }
    }

    if (turnContent) {
      appendMessage(deps.db, { sessionId: deps.sessionId, role: "assistant", content: turnContent });
      deps.publish("message.completed", { content: turnContent });
      answer = turnContent;
    }

    if (turnCalls.length === 0) {
      deps.publish("turn.completed", { answer, steps: step });
      return { answer, steps: step, usage };
    }

    history.push({ role: "assistant", content: turnContent });
    workingHistory.push({ role: "assistant", content: turnContent });
    for (const call of turnCalls) {
      deps.publish("tool.requested", { name: call.name, arguments: call.arguments });
      deps.publish("tool.started", { name: call.name });
      const result = await deps.tools.invoke(call.name, call.arguments, deps.toolContext, ids, (request) =>
        deps.publish("permission.requested", request),
      );
      const observation = truncateObservation(JSON.stringify(result));
      deps.publish("tool.result", {
        name: call.name,
        ok: result.ok,
        error: result.ok ? undefined : result.error,
      });
      appendMessage(deps.db, {
        sessionId: deps.sessionId,
        role: "tool",
        content: observation,
        toolName: call.name,
      });
      workingHistory.push({ role: "tool", content: observation, toolName: call.name });
    }
  }

  throw new Error("turn exceeded max steps (" + maxSteps + ")");
}

function attachImages(history: ChatMessage[], images: string[]): void {
  for (let i = history.length - 1; i >= 0; i--) {
    const message = history[i]!;
    if (message.role === "user") {
      message.images = images;
      return;
    }
  }
}

function toChatMessage(row: { role: string; content: string; tool_name: string | null }): ChatMessage {
  if (row.role === "tool") {
    return { role: "tool", content: row.content, toolName: row.tool_name ?? "" };
  }
  if (row.role === "assistant") {
    return { role: "assistant", content: row.content };
  }
  if (row.role === "system") {
    return { role: "system", content: row.content };
  }
  return { role: "user", content: row.content };
}
