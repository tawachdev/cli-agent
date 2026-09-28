import type { Migration } from "../migrate";

export const createTaskAndAuditTables: Migration = {
  name: "002_task_and_audit_tables",
  up(db) {
    db.run(
      "CREATE TABLE tasks (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, task TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'coder', state TEXT NOT NULL DEFAULT 'idle', plan TEXT, result TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)",
    );
    db.run(
      "CREATE INDEX idx_tasks_session ON tasks (session_id, id)",
    );
    db.run(
      "CREATE TABLE audit_events (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, session_id TEXT, task_id TEXT, type TEXT NOT NULL, payload TEXT NOT NULL DEFAULT '{}')",
    );
    db.run(
      "CREATE INDEX idx_audit_session ON audit_events (session_id, id)",
    );
  },
};
