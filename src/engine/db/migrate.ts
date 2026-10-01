import type { Db } from "./client";

export interface Migration {
  name: string;
  up(db: Db): void;
}

export function runMigrations(db: Db, migrations: readonly Migration[]): string[] {
  db.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)",
  );
  return db.transaction(() => {
    const appliedRows = db
      .query("SELECT name FROM schema_migrations")
      .all() as Array<{ name: string }>;
    const applied = new Set(appliedRows.map((row) => row.name));
    const appliedNow: string[] = [];
    for (const migration of migrations) {
      if (applied.has(migration.name)) continue;
      db.transaction(() => {
        migration.up(db);
        db.query("INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)").run(
          migration.name,
          new Date().toISOString(),
        );
      })();
      appliedNow.push(migration.name);
    }
    return appliedNow;
  })();
}
