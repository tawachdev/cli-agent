import { describe, expect, it } from "bun:test";
import { Agent } from "../src/engine/core/agent/agent";
import { createSession } from "../src/engine/core/agent/state";
import { SqliteAudit } from "../src/engine/core/audit/audit";
import { PermissionEngine } from "../src/engine/core/permissions/engine";
import { defaultPolicyFile } from "../src/engine/core/permissions/policy";
import { openDb } from "../src/engine/db/client";
import { runMigrations } from "../src/engine/db/migrate";
import { migrations } from "../src/engine/db/migrations";
import { ModelRouter } from "../src/engine/models/router";
import type { ModelProvider, StreamChunk } from "../src/engine/models/types";
import { ToolRegistry } from "../src/engine/tools/registry";

class SlowToStopProvider implements ModelProvider {
  private readonly waiting: (() => void)[] = [];

  release(): void {
    for (const resume of this.waiting.splice(0)) resume();
  }

  async *complete(): AsyncGenerator<StreamChunk> {
    yield { type: "token", text: "working" };
    await new Promise<void>((resolve) => this.waiting.push(resolve));
    yield { type: "token", text: "still writing after abort" };
  }
}

describe("aborting a task", () => {
  it("keeps the session busy until the aborted task has actually stopped", async () => {
    const db = openDb(":memory:");
    runMigrations(db, migrations);
    const audit = new SqliteAudit(db);
    const permissions = new PermissionEngine(
      defaultPolicyFile(),
      { create: async () => true, resolve: () => ({ ok: false }) },
      audit,
    );
    const provider = new SlowToStopProvider();
    const agent = new Agent({
      agentName: () => "TEST",
      db,
      router: new ModelRouter(() => ({ provider, providerName: "fake", model: "fake" })),
      tools: new ToolRegistry(permissions),
      toolContext: { workspaceRoot: "/tmp" },
      numCtx: 4096,
      temperature: 0.2,
      audit,
      permissions,
    });
    const session = createSession(db, null);
    const first = agent.runTask(session.id, "slow", "coder", () => {}).catch((error: Error) => error);
    await Bun.sleep(10);

    expect(agent.abortSession(session.id)).toBe(true);
    const second = agent.runTask(session.id, "second", "coder", () => {}).catch((error: Error) => error);
    await Bun.sleep(10);
    provider.release();
    expect(String(await second)).toContain("already has a running task");
    expect(await first).toBeInstanceOf(Error);
    expect(agent.aborts.hasRunning(session.id)).toBe(false);
    db.close();
  }, 5000);
});
