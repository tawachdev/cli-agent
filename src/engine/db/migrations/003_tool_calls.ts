import type { Migration } from "../migrate";

export const addToolCallColumns: Migration = {
  name: "003_message_tool_calls",
  up(db) {
    db.run("ALTER TABLE messages ADD COLUMN tool_calls TEXT");
    db.run("ALTER TABLE messages ADD COLUMN tool_call_id TEXT");
  },
};
