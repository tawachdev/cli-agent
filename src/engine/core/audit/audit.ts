import type { Db } from "../../db/client";
import type { TaskState } from "../agent/orchestrator";

export interface AuditWriter {
  write(type: string, payload: Record<string, unknown>, ids?: { sessionId?: string; taskId?: string }): void;
}

export class SqliteAudit implements AuditWriter {
  constructor(private readonly db: Db) {}

  write(type: string, payload: Record<string, unknown>, ids?: { sessionId?: string; taskId?: string }): void {
    this.db
      .query("INSERT INTO audit_events (ts, session_id, task_id, type, payload) VALUES (?, ?, ?, ?, ?)")
      .run(
        new Date().toISOString(),
        ids?.sessionId ?? null,
        ids?.taskId ?? null,
        type,
        JSON.stringify(payload),
      );
  }
}

export interface TaskRow {
  id: string;
  session_id: string;
  task: string;
  role: string;
  state: TaskState;
  plan: string | null;
  result: string | null;
  created_at: string;
  updated_at: string;
}

export function createTask(db: Db, sessionId: string, task: string, role: string): TaskRow {
  const now = new Date().toISOString();
  const row = {
    id: crypto.randomUUID(),
    session_id: sessionId,
    task,
    role,
    state: "idle" as TaskState,
    plan: null,
    result: null,
    created_at: now,
    updated_at: now,
  };
  db.query(
    "INSERT INTO tasks (id, session_id, task, role, state, plan, result, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(row.id, row.session_id, row.task, row.role, row.state, row.plan, row.result, row.created_at, row.updated_at);
  return row;
}

export function getTask(db: Db, id: string): TaskRow | null {
  return (db.query("SELECT id, session_id, task, role, state, plan, result, created_at, updated_at FROM tasks WHERE id = ?").get(id) ?? null) as TaskRow | null;
}

export function updateTaskState(db: Db, id: string, state: TaskState): void {
  db.query("UPDATE tasks SET state = ?, updated_at = ? WHERE id = ?").run(state, new Date().toISOString(), id);
}

export function updateTaskResult(db: Db, id: string, fields: { plan?: string; result?: string; state?: TaskState }): void {
  const row = getTask(db, id);
  if (!row) return;
  db.query("UPDATE tasks SET state = ?, plan = ?, result = ?, updated_at = ? WHERE id = ?").run(
    fields.state ?? row.state,
    fields.plan ?? row.plan,
    fields.result ?? row.result,
    new Date().toISOString(),
    id,
  );
}
