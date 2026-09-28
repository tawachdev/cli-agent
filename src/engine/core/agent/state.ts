import type { Db } from "../../db/client";

export interface SessionRow {
  id: string;
  title: string | null;
  created_at: string;
  updated_at: string;
}

export interface MessageRow {
  id: number;
  session_id: string;
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_name: string | null;
  created_at: string;
}

export function createSession(db: Db, title: string | null): SessionRow {
  const now = new Date().toISOString();
  const row = { id: crypto.randomUUID(), title, created_at: now, updated_at: now };
  db.query("INSERT INTO sessions (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)").run(
    row.id,
    row.title,
    row.created_at,
    row.updated_at,
  );
  return row;
}

export function getSession(db: Db, id: string): SessionRow | null {
  return (db
    .query("SELECT id, title, created_at, updated_at FROM sessions WHERE id = ?")
    .get(id) ?? null) as SessionRow | null;
}

export function listMessages(db: Db, sessionId: string): MessageRow[] {
  return db
    .query(
      "SELECT id, session_id, role, content, tool_name, created_at FROM messages WHERE session_id = ? ORDER BY id",
    )
    .all(sessionId) as MessageRow[];
}

export function appendMessage(
  db: Db,
  message: { sessionId: string; role: MessageRow["role"]; content: string; toolName?: string },
): void {
  db.query("INSERT INTO messages (session_id, role, content, tool_name) VALUES (?, ?, ?, ?)").run(
    message.sessionId,
    message.role,
    message.content,
    message.toolName ?? null,
  );
}
