import type { Migration } from "../migrate";
import { createSessionTables } from "./001_sessions";
import { createTaskAndAuditTables } from "./002_tasks_audit";
import { addToolCallColumns } from "./003_tool_calls";

export const migrations: Migration[] = [createSessionTables, createTaskAndAuditTables, addToolCallColumns];
