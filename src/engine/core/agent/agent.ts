import type { Db } from "../../db/client";
import type { ModelRole } from "../../models/types";
import type { ModelRouter } from "../../models/router";
import type { ToolContext } from "../../tools/types";
import type { ToolRegistry } from "../../tools/registry";
import type { AuditWriter } from "../audit/audit";
import { createTask, updateTaskResult, updateTaskState } from "../audit/audit";
import type { PermissionEngine } from "../permissions/engine";
import { runCheck } from "../verifier/verifier";
import type { PublishEvent } from "./loop";
import { runTurn, type TurnResult } from "./loop";
import { runPlanner } from "./planner";
import { getSession } from "./state";

export interface AgentDeps {
  db: Db;
  router: ModelRouter;
  tools: ToolRegistry;
  toolContext: ToolContext;
  numCtx: number;
  temperature: number;
  maxSteps?: number;
  audit: AuditWriter;
  permissions: PermissionEngine;
  checkCommand?: string;
}

export class SessionNotFoundError extends Error {
  constructor(sessionId: string) {
    super(`session not found: ${sessionId}`);
  }
}

export class TurnError extends Error {
  constructor(
    message: string,
    readonly taskId: string,
    readonly status: 409 | 500,
  ) {
    super(message);
  }
}

export class TaskNotFoundError extends Error {
  constructor(taskId: string) {
    super(`task not found: ${taskId}`);
  }
}

export class AbortRegistry {
  private readonly entries = new Map<string, { controller: AbortController; sessionId?: string }>();

  create(taskId: string, sessionId?: string): AbortController {
    const controller = new AbortController();
    this.entries.set(taskId, { controller, sessionId });
    return controller;
  }

  abort(taskId: string): boolean {
    const entry = this.entries.get(taskId);
    if (!entry) return false;
    entry.controller.abort();
    this.entries.delete(taskId);
    return true;
  }

  abortSession(sessionId: string): boolean {
    let aborted = false;
    for (const [taskId, entry] of this.entries) {
      if (entry.sessionId === sessionId && this.abort(taskId)) aborted = true;
    }
    return aborted;
  }

  hasRunning(sessionId: string): boolean {
    for (const entry of this.entries.values()) {
      if (entry.sessionId === sessionId) return true;
    }
    return false;
  }

  release(taskId: string): void {
    this.entries.delete(taskId);
  }
}

export class Agent {
  readonly aborts = new AbortRegistry();

  constructor(private readonly deps: AgentDeps) {}

  abortTask(taskId: string): boolean {
    return this.aborts.abort(taskId);
  }

  abortSession(sessionId: string): boolean {
    return this.aborts.abortSession(sessionId);
  }

  async runTask(
    sessionId: string,
    task: string,
    role: ModelRole,
    publish: PublishEvent,
    images: string[] = [],
  ): Promise<TurnResult & { taskId: string }> {
    if (!getSession(this.deps.db, sessionId)) {
      throw new SessionNotFoundError(sessionId);
    }
    if (this.aborts.hasRunning(sessionId)) {
      throw new Error("session already has a running task");
    }
    const row = createTask(this.deps.db, sessionId, task, role);
    const audit = (type: string, payload: Record<string, unknown>) =>
      this.deps.audit.write(type, payload, { sessionId, taskId: row.id });
    audit("task.created", { task, role });

    const setState = (state: "planning" | "executing" | "verifying" | "completed") => {
      updateTaskState(this.deps.db, row.id, state);
      publish("state.changed", { taskId: row.id, state });
      audit("task.state", { state });
    };

    const controller = this.aborts.create(row.id, sessionId);
    try {
      setState("planning");
      const plan = await runPlanner(
        this.deps.router.resolve(role),
        this.deps.numCtx,
        this.deps.temperature,
        task,
        controller.signal,
        publish,
      );
      updateTaskResult(this.deps.db, row.id, { plan });
      audit("task.plan", { plan });

      setState("executing");
      const result = await runTurn(
        {
          db: this.deps.db,
          binding: this.deps.router.resolve(role),
          tools: this.deps.tools,
          toolContext: { ...this.deps.toolContext, signal: controller.signal },
          publish,
          numCtx: this.deps.numCtx,
          temperature: this.deps.temperature,
          maxSteps: this.deps.maxSteps,
          sessionId,
          taskId: row.id,
          signal: controller.signal,
        },
        task,
        images,
      );

      setState("verifying");
      if (this.deps.checkCommand) {
        const check = await runCheck(this.deps.checkCommand, this.deps.toolContext.workspaceRoot, controller.signal);
        publish("verify.result", { ok: check.ok, command: this.deps.checkCommand, output: check.output });
        audit("task.verify", { ok: check.ok, command: this.deps.checkCommand });
        if (!check.ok) {
          throw new Error("verification failed: check command did not pass");
        }
      }
      setState("completed");
      updateTaskResult(this.deps.db, row.id, {
        state: "completed",
        result: JSON.stringify({ answer: result.answer, steps: result.steps }),
      });
      audit("task.completed", { steps: result.steps });
      return { ...result, taskId: row.id };
    } catch (error) {
      if (controller.signal.aborted) {
        updateTaskResult(this.deps.db, row.id, { state: "aborted" });
        publish("turn.aborted", { taskId: row.id, reason: "aborted by user" });
        audit("task.aborted", {});
        throw new TurnError("task aborted", row.id, 409);
      }
      updateTaskResult(this.deps.db, row.id, { state: "failed" });
      const reason = error instanceof Error ? error.message : String(error);
      publish("turn.failed", { taskId: row.id, reason });
      audit("task.failed", { reason });
      throw new TurnError(reason, row.id, 500);
    } finally {
      this.aborts.release(row.id);
    }
  }
}
