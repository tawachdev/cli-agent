import type { Migration } from "../migrate";

export const createSessionTables: Migration = {
  name: "001_session_tables",
  up(db) {
    db.run(
      "CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)",
    );
    db.run(
      "CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, role TEXT NOT NULL CHECK (role IN ('system', 'user', 'assistant', 'tool')), content TEXT NOT NULL DEFAULT '', tool_name TEXT, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')))",
    );
    db.run("CREATE INDEX idx_messages_session ON messages (session_id, id)");
  },
};
