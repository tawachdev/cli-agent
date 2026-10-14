import { describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/engine/db/client";

const modeOf = (path: string) => statSync(path).mode & 0o777;

describe("database files are private to the owner", () => {
  it("creates the data dir, database, and WAL files owner-only", () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), "db-perm-")), "state", "agent.db");
    const db = openDb(dbPath);
    db.exec("CREATE TABLE t (x INTEGER); INSERT INTO t VALUES (1);");
    expect(modeOf(join(dbPath, ".."))).toBe(0o700);
    for (const file of [dbPath, dbPath + "-wal", dbPath + "-shm"]) expect(modeOf(file)).toBe(0o600);
    db.close();
  });

  it("tightens an existing world-readable database", () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), "db-perm-")), "agent.db");
    writeFileSync(dbPath, "");
    chmodSync(dbPath, 0o644);
    openDb(dbPath).close();
    expect(modeOf(dbPath)).toBe(0o600);
  });
});
