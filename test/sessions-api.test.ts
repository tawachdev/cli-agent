import { describe, expect, it } from "bun:test";
import { createSessionsRoute } from "../src/engine/api/routes/sessions";
import { PendingPermissions } from "../src/engine/core/permissions/pending";
import { StreamRegistry } from "../src/engine/api/ws/agent-stream";
import { openDb } from "../src/engine/db/client";
import { runMigrations } from "../src/engine/db/migrate";
import { migrations } from "../src/engine/db/migrations";

describe("sessions API", () => {
  it("creates sessions, rejects unknown ids and stores messages", async () => {
    const db = openDb(":memory:");
    runMigrations(db, migrations);
    const app = createSessionsRoute(db, new PendingPermissions(), new StreamRegistry());

    const created = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "test session" }),
    });
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as { session: { id: string; title: string } };
    expect(createdBody.session.title).toBe("test session");
    const id = createdBody.session.id;

    const list = await app.request("/");
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as { sessions: Array<{ id: string; title: string }> };
    expect(listBody.sessions.some((session) => session.id === id)).toBe(true);

    const appended = await app.request(`/${id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ role: "user", content: "hi there" }),
    });
    expect(appended.status).toBe(201);

    const messages = await app.request(`/${id}/messages`);
    expect(messages.status).toBe(200);
    const messagesBody = (await messages.json()) as {
      messages: Array<{ role: string; content: string }>;
    };
    expect(messagesBody.messages).toHaveLength(1);
    expect(messagesBody.messages[0]?.content).toBe("hi there");

    const missing = await app.request("/does-not-exist");
    expect(missing.status).toBe(404);
    const missingMessages = await app.request("/does-not-exist/messages");
    expect(missingMessages.status).toBe(404);

    const invalid = await app.request(`/${id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ role: "assistant", content: "forged" }),
    });
    expect(invalid.status).toBe(400);
    db.close();
  });
});
