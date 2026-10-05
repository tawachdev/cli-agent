import { describe, expect, it } from "bun:test";
import { OpenAICompatProvider } from "../src/engine/models/openai-provider";
import { AnthropicProvider } from "../src/engine/models/anthropic-provider";
import type { ChatMessage, GenerateRequest } from "../src/engine/models/types";
import { parseToolCalls } from "../src/engine/models/types";
import { appendMessage, createSession, listMessages } from "../src/engine/core/agent/state";
import { openDb } from "../src/engine/db/client";
import { runMigrations, type Migration } from "../src/engine/db/migrate";
import { migrations } from "../src/engine/db/migrations";
import { createSessionTables } from "../src/engine/db/migrations/001_sessions";
import { createTaskAndAuditTables } from "../src/engine/db/migrations/002_tasks_audit";
import { compactHistory } from "../src/engine/core/context/compaction";
import type { ModelBinding } from "../src/engine/models/router";
import type { ModelProvider, StreamChunk } from "../src/engine/models/types";

function captureServer(path: string, responseBody: string): {
  url: string;
  stop: () => void;
  bodies: Record<string, unknown>[];
} {
  const bodies: Record<string, unknown>[] = [];
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      if (new URL(request.url).pathname === path) {
        bodies.push((await request.json().catch(() => null)) as Record<string, unknown>);
        return new Response(responseBody, { headers: { "content-type": "text/event-stream" } });
      }
      return new Response("not found", { status: 404 });
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true), bodies };
}

function freshDb() {
  const db = openDb(":memory:");
  runMigrations(db, migrations);
  return db;
}

const CALL_A = { id: "call_aaa", name: "fs.read", arguments: { path: "src/index.ts" }, thoughtSignature: "sig-gemini-aaa" };
const CALL_B = { id: "call_bbb", name: "shell.exec", arguments: { command: "bun test src/index.test.ts", timeout: 30 } };

function seedToolTurn(db: ReturnType<typeof openDb>, sessionId: string): void {
  appendMessage(db, {
    sessionId,
    role: "user",
    content: "check the index file",
  });
  appendMessage(db, {
    sessionId,
    role: "assistant",
    content: "Reading it now.",
    toolCalls: [CALL_A, CALL_B],
  });
  appendMessage(db, {
    sessionId,
    role: "tool",
    content: '{"ok":true,"output":"export const x = 1"}',
    toolName: "fs.read",
    toolCallId: CALL_A.id,
  });
  appendMessage(db, {
    sessionId,
    role: "tool",
    content: '{"ok":true,"output":"3 pass"}',
    toolName: "shell.exec",
    toolCallId: CALL_B.id,
  });
}

describe("canonical tool-call persistence", () => {
  it("persists assistant tool calls with exact arguments and stable ids", () => {
    const db = freshDb();
    const session = createSession(db, null);
    seedToolTurn(db, session.id);

    const rows = listMessages(db, session.id);
    const assistant = rows.find((row) => row.role === "assistant");
    expect(assistant?.tool_calls).toBeTruthy();
    expect(parseToolCalls(assistant?.tool_calls)).toEqual([CALL_A, CALL_B]);

    const results = rows.filter((row) => row.role === "tool");
    expect(results.map((row) => row.tool_call_id)).toEqual([CALL_A.id, CALL_B.id]);
    db.close();
  });

  it("rebuilds identical history after session reload", () => {
    const db = freshDb();
    const session = createSession(db, null);
    seedToolTurn(db, session.id);

    const first = listMessages(db, session.id);
    const second = listMessages(db, session.id);
    expect(second).toEqual(first);
    const calls = parseToolCalls(second.find((row) => row.role === "assistant")?.tool_calls);
    expect(calls[0]).toEqual(CALL_A);
    expect(calls[1]).toEqual(CALL_B);
    db.close();
  });

  it("keeps legacy rows (no tool calls) readable after migration", () => {
    const db = openDb(":memory:");
    const legacy: Migration[] = [createSessionTables, createTaskAndAuditTables];
    runMigrations(db, legacy);
    const session = createSession(db, null);
    db.query("INSERT INTO messages (session_id, role, content, tool_name) VALUES (?, ?, ?, ?)").run(
      session.id,
      "tool",
      "old observation",
      "fs.read",
    );
    runMigrations(db, migrations);

    const rows = listMessages(db, session.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.content).toBe("old observation");
    expect(rows[0]?.tool_calls).toBeNull();
    expect(parseToolCalls(rows[0]?.tool_calls)).toEqual([]);
    db.close();
  });
});

describe("provider serialization of canonical history", () => {
  const reloaded = (): ChatMessage[] => {
    const db = freshDb();
    const session = createSession(db, null);
    seedToolTurn(db, session.id);
    const rows = listMessages(db, session.id);
    db.close();
    return rows.map((row) => {
      if (row.role === "assistant") {
        return { role: "assistant", content: row.content, toolCalls: parseToolCalls(row.tool_calls) };
      }
      if (row.role === "tool") {
        return { role: "tool", content: row.content, toolName: row.tool_name ?? "", toolCallId: row.tool_call_id ?? undefined };
      }
      return { role: "user", content: row.content } as ChatMessage;
    });
  };

  it("OpenAI: assistant tool_calls keep ids, exact arguments and order; results carry matching tool_call_id", async () => {
    const mock = captureServer("/chat/completions", "data: [DONE]\n\n");
    const provider = new OpenAICompatProvider(mock.url, "sk-test", "fake");
    const request: GenerateRequest = { model: "m", messages: reloaded(), numCtx: 4096 };
    for await (const _ of provider.complete(request)) {
      // drain
    }
    mock.stop();

    const messages = mock.bodies[0]?.["messages"] as Array<Record<string, unknown>>;
    const assistant = messages.find((m) => m["role"] === "assistant" && Array.isArray(m["tool_calls"]));
    expect(assistant).toBeDefined();
    const calls = assistant?.["tool_calls"] as Array<{ id: string; function: { name: string; arguments: string } }>;
    expect(calls.map((c) => c.id)).toEqual([CALL_A.id, CALL_B.id]);
    expect(calls.map((c) => c.function.name)).toEqual(["fs.read", "shell.exec"]);
    expect(JSON.parse(calls[0]?.function.arguments as string)).toEqual(CALL_A.arguments);
    expect(JSON.parse(calls[1]?.function.arguments as string)).toEqual(CALL_B.arguments);

    const toolMessages = messages.filter((m) => m["role"] === "tool");
    expect(toolMessages.map((m) => m["tool_call_id"])).toEqual([CALL_A.id, CALL_B.id]);

    const firstCall = calls[0] as { extra_content?: { google?: { thought_signature?: string } } };
    expect(firstCall.extra_content?.google?.thought_signature).toBe("sig-gemini-aaa");
  });

  it("Anthropic: tool_use blocks keep ids and input; tool_result blocks reference their tool_use_id", async () => {
    const mock = captureServer("/messages", "data: {\"type\":\"message_stop\"}\n\n");
    const provider = new AnthropicProvider(mock.url, "sk-test", "fake");
    const request: GenerateRequest = { model: "m", messages: reloaded(), numCtx: 4096 };
    for await (const _ of provider.complete(request)) {
      // drain
    }
    mock.stop();

    const messages = mock.bodies[0]?.["messages"] as Array<{ role: string; content: unknown }>;
    const assistant = messages.find((m) => m.role === "assistant");
    const blocks = assistant?.content as Array<Record<string, unknown>>;
    const toolUses = blocks.filter((b) => b["type"] === "tool_use");
    expect(toolUses.map((b) => b["id"])).toEqual([CALL_A.id, CALL_B.id]);
    expect(toolUses.map((b) => b["name"])).toEqual(["fs.read", "shell.exec"]);
    expect(toolUses[0]?.["input"]).toEqual(CALL_A.arguments);
    expect(toolUses[1]?.["input"]).toEqual(CALL_B.arguments);

    const userTurn = messages.find(
      (m) => m.role === "user" && Array.isArray(m.content) && (m.content as Array<Record<string, unknown>>).some((b) => b["type"] === "tool_result"),
    );
    const results = (userTurn?.content as Array<Record<string, unknown>>).filter((b) => b["type"] === "tool_result");
    expect(results.map((b) => b["tool_use_id"])).toEqual([CALL_A.id, CALL_B.id]);
  });
});

describe("compaction preserves tool-call semantics", () => {
  it("never keeps a tool result whose assistant call was summarized away", async () => {
    const history: ChatMessage[] = [
      { role: "system", content: "system" },
      { role: "user", content: "long task " + "x".repeat(200) },
    ];
    for (let i = 0; i < 6; i += 1) {
      history.push({
        role: "assistant",
        content: `step ${i} reading`,
        toolCalls: [{ id: `call_${i}`, name: "fs.read", arguments: { path: `f${i}.ts` } }],
      });
      history.push({ role: "tool", content: "out ".repeat(200), toolName: "fs.read", toolCallId: `call_${i}` });
    }
    history.push({ role: "assistant", content: "final answer", toolCalls: [] });

    const summarizer: ModelProvider = {
      async *complete(): AsyncGenerator<StreamChunk> {
        yield { type: "token", text: "summary of old steps" };
      },
    };
    const binding: ModelBinding = { provider: summarizer, model: "fake" };
    const events: Array<{ type: string; payload: unknown }> = [];
    const { history: compacted } = await compactHistory(
      { binding, numCtx: 1024, temperature: 0.2, publish: (type, payload) => events.push({ type, payload }) },
      history,
    );

    expect(events.some((event) => event.type === "context.compacted")).toBe(true);
    for (let i = 0; i < compacted.length; i += 1) {
      const message = compacted[i] as ChatMessage;
      if (message.role === "tool") {
        const previous = compacted[i - 1] as ChatMessage | undefined;
        expect(previous?.role).toBe("assistant");
        expect((previous as { toolCalls?: unknown[] }).toolCalls?.length ?? 0).toBeGreaterThan(0);
        const ids = (previous as { toolCalls: Array<{ id: string }> }).toolCalls.map((call) => call.id);
        expect(ids).toContain((message as { toolCallId?: string }).toolCallId ?? "");
      }
    }
  });
});
