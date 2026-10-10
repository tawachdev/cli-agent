import type { Db } from "../../db/client";
import type { ModelBinding } from "../../models/router";
import type { ChatMessage, PersistedToolCall, TokenUsage, ToolCall } from "../../models/types";
import { parseToolCalls } from "../../models/types";
import { compactHistory } from "../context/compaction";
import { truncateObservation } from "../context/truncation";
import type { AuditWriter } from "../audit/audit";
import type { ToolRegistry } from "../../tools/registry";
import { appendMessage, listMessages } from "./state";

export type PublishEvent = (type: string, payload: unknown) => void;

export interface TurnDeps {
  db: Db;
  agentName: () => string;
  binding: ModelBinding;
  failover?: (failed: ModelBinding, reason: string) => ModelBinding | null;
  tools: ToolRegistry;
  toolContext: { workspaceRoot: string; signal?: AbortSignal };
  publish: PublishEvent;
  audit?: AuditWriter;
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

export function systemPrompt(agentName: string): string {
  return (
    `You are ${agentName}, a personal coding agent running fully local on this machine (never claim to be another assistant or model). ` +
    "Use the provided tools to gather information before answering questions about the workspace. " +
    "After using tools, give your final answer in plain prose. Be concise and factual."
  );
}

export async function runTurn(deps: TurnDeps, task: string, images: string[] = []): Promise<TurnResult> {
  const maxSteps = deps.maxSteps ?? 6;
  deps.publish("turn.started", { task });
  appendMessage(deps.db, { sessionId: deps.sessionId, role: "user", content: task });

  const history: ChatMessage[] = [
    { role: "system", content: systemPrompt(deps.agentName()) },
    ...listMessages(deps.db, deps.sessionId).map(toChatMessage),
  ];
  if (images.length > 0) attachImages(history, images);
  const specs = deps.tools.specs();
  let workingHistory = history;
  let answer = "";
  let usage: TokenUsage | null = null;
  const ids = { sessionId: deps.sessionId, taskId: deps.taskId };

  const callWithFailover = async <T>(run: (binding: ModelBinding) => Promise<T>): Promise<T> => {
    let active = deps.binding;
    for (;;) {
      try {
        return await run(active);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        if (deps.signal?.aborted) throw error;
        if (!/\b401\b|\b403\b|\b503\b|Unable to connect|ECONNREFUSED|fetch failed|high demand/i.test(reason) || !deps.failover) throw error;
        const next = deps.failover?.(active, reason);
        if (!next) throw error;
        active = next;
        deps.publish("provider.failover", { reason: reason.slice(0, 120) });
      }
    }
  };

  for (let step = 1; step <= maxSteps; step++) {
    const compacted = await callWithFailover((binding) =>
      compactHistory(
        {
          binding,
          numCtx: deps.numCtx,
          temperature: deps.temperature ?? 0.2,
          signal: deps.signal,
          publish: deps.publish,
        },
        workingHistory,
      ),
    );
    workingHistory = compacted.history;
    const turnCalls: ToolCall[] = [];
    let turnContent = "";
    await callWithFailover(async (binding) => {
      turnContent = "";
      turnCalls.length = 0;
      for await (const chunk of binding.provider.complete(
        {
          model: binding.model,
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
    });

    if (turnCalls.length === 0) {
      if (turnContent) {
        answer = turnContent;
        appendMessage(deps.db, { sessionId: deps.sessionId, role: "assistant", content: turnContent });
        deps.publish("message.completed", { content: turnContent });
      }
      deps.publish("turn.completed", { answer, steps: step });
      return { answer, steps: step, usage };
    }

    if (turnCalls.length > 0 && step === maxSteps) {
      throw new Error("turn exceeded max steps (" + maxSteps + ")");
    }
    const persistedCalls: PersistedToolCall[] = turnCalls.map((call, index) => ({
      id: call.id ?? `turn${step}_call${index + 1}`,
      name: call.name,
      arguments: call.arguments,
      ...(call.thoughtSignature ? { thoughtSignature: call.thoughtSignature } : {}),
    }));
    appendMessage(deps.db, {
      sessionId: deps.sessionId,
      role: "assistant",
      content: turnContent,
      toolCalls: persistedCalls,
    });
    workingHistory.push({ role: "assistant", content: turnContent, toolCalls: persistedCalls });
    if (turnContent) deps.publish("message.completed", { content: turnContent });
    for (const call of persistedCalls) {
      deps.publish("tool.requested", { name: call.name, arguments: call.arguments });
      deps.publish("tool.started", { name: call.name });
      deps.audit?.write("tool.requested", { name: call.name, arguments: JSON.stringify(call.arguments).slice(0, 500) });
      const startedAt = Date.now();
      const result = await deps.tools.invoke(call.name, call.arguments, deps.toolContext, ids, (request) =>
        deps.publish("permission.requested", request),
      );
      const durationMs = Date.now() - startedAt;
      deps.audit?.write("tool.result", { name: call.name, ok: result.ok, durationMs });
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
        toolCallId: call.id,
      });
      workingHistory.push({ role: "tool", content: observation, toolName: call.name, toolCallId: call.id });
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

function toChatMessage(row: {
  role: string;
  content: string;
  tool_name: string | null;
  tool_calls: string | null;
  tool_call_id: string | null;
}): ChatMessage {
  if (row.role === "tool") {
    return {
      role: "tool",
      content: row.content,
      toolName: row.tool_name ?? "",
      toolCallId: row.tool_call_id ?? undefined,
    };
  }
  if (row.role === "assistant") {
    const calls = parseToolCalls(row.tool_calls);
    return calls.length > 0
      ? { role: "assistant", content: row.content, toolCalls: calls }
      : { role: "assistant", content: row.content };
  }
  if (row.role === "system") {
    return { role: "system", content: row.content };
  }
  return { role: "user", content: row.content };
}
