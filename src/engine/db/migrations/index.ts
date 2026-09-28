import type { Migration } from "../migrate";
import { createSessionTables } from "./001_sessions";
import { createTaskAndAuditTables } from "./002_tasks_audit";

export const migrations: Migration[] = [createSessionTables, createTaskAndAuditTables];
