import { describe, expect, it } from "bun:test";
import { openDb } from "../src/engine/db/client";
import { runMigrations, type Migration } from "../src/engine/db/migrate";

describe("runMigrations", () => {
  it("applies pending migrations once, in order, and is idempotent", () => {
    const db = openDb(":memory:");
    const migrations: Migration[] = [
      {
        name: "001_items",
        up: (d) => {
          d.exec("CREATE TABLE items (id INTEGER PRIMARY KEY)");
        },
      },
      {
        name: "002_items_name",
        up: (d) => {
          d.exec("ALTER TABLE items ADD COLUMN name TEXT");
        },
      },
    ];
    expect(runMigrations(db, migrations)).toEqual(["001_items", "002_items_name"]);
    expect(runMigrations(db, migrations)).toEqual([]);
    const rows = db
      .query("SELECT name FROM schema_migrations ORDER BY name")
      .all() as Array<{ name: string }>;
    expect(rows.map((row) => row.name)).toEqual(["001_items", "002_items_name"]);
    db.close();
  });

  it("rolls back and does not record a failing migration", () => {
    const db = openDb(":memory:");
    const failing: Migration = {
      name: "003_broken",
      up: (d) => {
        d.exec("CREATE TABLE broken (id INTEGER)");
        d.exec("THIS IS NOT SQL");
      },
    };
    expect(() => runMigrations(db, [failing])).toThrow();
    const applied = db
      .query("SELECT name FROM schema_migrations")
      .all() as Array<{ name: string }>;
    expect(applied.map((row) => row.name)).not.toContain("003_broken");
    const leftover = db
      .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'broken'")
      .all();
    expect(leftover).toHaveLength(0);
    db.close();
  });
});
