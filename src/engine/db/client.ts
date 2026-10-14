import { Database } from "bun:sqlite";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";

export type Db = Database;

const OWNER_ONLY_DIR = 0o700;
const OWNER_ONLY_FILE = 0o600;
const SIDE_FILES = ["-wal", "-shm"];

function restrictToOwner(dbPath: string): void {
  mkdirSync(dirname(dbPath), { recursive: true, mode: OWNER_ONLY_DIR });
  closeSync(openSync(dbPath, "a", OWNER_ONLY_FILE));
  for (const file of [dbPath, ...SIDE_FILES.map((suffix) => dbPath + suffix)]) {
    if (existsSync(file)) chmodSync(file, OWNER_ONLY_FILE);
  }
}

export function openDb(dbPath: string): Db {
  if (dbPath !== ":memory:") restrictToOwner(dbPath);
  const db = new Database(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA foreign_keys = ON");
  return db;
}
