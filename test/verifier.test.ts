import { describe, expect, it } from "bun:test";
import { runCheck } from "../src/engine/core/verifier/verifier";
import { shellExecTool } from "../src/engine/tools/shell/exec";
import { createTask, transitionTaskState } from "../src/engine/core/audit/audit";
import { IllegalTransitionError } from "../src/engine/core/agent/orchestrator";
import { openDb } from "../src/engine/db/client";
import { runMigrations } from "../src/engine/db/migrate";
import { migrations } from "../src/engine/db/migrations";
import { createSession } from "../src/engine/core/agent/state";

describe("runCheck statuses", () => {
  it("reports passed for an exiting-zero command", async () => {
    const check = await runCheck("echo ok", "/tmp");
    expect(check.status).toBe("passed");
    expect(check.ok).toBe(true);
    expect(check.exitCode).toBe(0);
  });

  it("reports failed with the output for a failing command", async () => {
    const check = await runCheck("echo broken >&2; exit 2", "/tmp");
    expect(check.status).toBe("failed");
    expect(check.ok).toBe(false);
    expect(check.exitCode).toBe(2);
    expect(check.output).toContain("broken");
  });

  it("reports aborted before start when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const check = await runCheck("echo no", "/tmp", controller.signal);
    expect(check.status).toBe("aborted");
    expect(check.ok).toBe(false);
  });

  it("reports aborted when the signal fires mid-run", async () => {
    const controller = new AbortController();
    const run = runCheck("sleep 5", "/tmp", controller.signal);
    await Bun.sleep(50);
    controller.abort();
    const check = await run;
    expect(check.status).toBe("aborted");
    expect(check.ok).toBe(false);
  });

  it("reports timedout and kills the process at the deadline", async () => {
    const check = await runCheck("sleep 30", "/tmp", undefined, 80);
    expect(check.status).toBe("timedout");
    expect(check.ok).toBe(false);
  });
});

describe("shell tool cancellation", () => {
  it("returns promptly with an abort result when the signal fires", async () => {
    const controller = new AbortController();
    const run = shellExecTool.invoke({ command: "sleep 30", timeoutMs: 600_000 }, {
      workspaceRoot: "/tmp",
      signal: controller.signal,
    });
    await Bun.sleep(50);
    const started = Date.now();
    controller.abort();
    const result = await run;
    expect(Date.now() - started).toBeLessThan(5000);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("aborted");
    }
  });
});

describe("runtime state transitions", () => {
  it("enforces legality against the database and is terminal about it", () => {
    const db = openDb(":memory:");
    runMigrations(db, migrations);
    const session = createSession(db, null);
    const task = createTask(db, session.id, "t", "coder");

    expect(transitionTaskState(db, task.id, "executing")).toBe("idle");
    expect(transitionTaskState(db, task.id, "verifying")).toBe("executing");
    expect(transitionTaskState(db, task.id, "completed")).toBe("verifying");

    expect(() => transitionTaskState(db, task.id, "failed")).toThrow(IllegalTransitionError);
    expect(() => transitionTaskState(db, task.id, "executing")).toThrow(IllegalTransitionError);

    const row = db.query("SELECT state FROM tasks WHERE id = ?").get(task.id) as { state: string };
    expect(row.state).toBe("completed");
    db.close();
  });

  it("refuses illegal transitions without writing", () => {
    const db = openDb(":memory:");
    runMigrations(db, migrations);
    const session = createSession(db, null);
    const task = createTask(db, session.id, "t", "coder");
    expect(() => transitionTaskState(db, task.id, "completed")).toThrow(IllegalTransitionError);
    const row = db.query("SELECT state, updated_at FROM tasks WHERE id = ?").get(task.id) as {
      state: string;
    };
    expect(row.state).toBe("idle");
    db.close();
  });
});
