import type { PermissionClass } from "../../tools/types";
import type { AuditWriter } from "../audit/audit";
import { decideAction, type PermissionAction, type PolicyFile } from "./policy";
import type { PermissionOwner } from "./pending";

export interface PermissionRequest {
  requestId: string;
  class: PermissionClass;
  target: string;
  preview?: string;
  sessionId?: string;
  taskId?: string;
  expiresAt: string;
}

export interface PermissionDecision {
  action: PermissionAction;
  granted: boolean;
}

export interface PendingRegistry {
  create(requestId: string, owner?: PermissionOwner): Promise<boolean>;
  resolve(requestId: string, approved: boolean, claimed?: PermissionOwner): { ok: boolean; reason?: string };
}

export type AskNotifier = (request: PermissionRequest) => void;

const PENDING_TIMEOUT_MS = 5 * 60 * 1000;

export class PermissionEngine {
  constructor(
    private readonly policy: PolicyFile,
    private readonly pending: PendingRegistry,
    private readonly audit: AuditWriter,
  ) {}

  async authorize(
    cls: PermissionClass,
    target: string,
    ids: { sessionId?: string; taskId?: string } = {},
    notify?: AskNotifier,
    signal?: AbortSignal,
  ): Promise<PermissionDecision> {
    const action = decideAction(this.policy, cls, target);
    this.audit.write("permission.decided", { class: cls, target, action }, ids);
    if (action === "allow") return { action, granted: true };
    if (action === "deny") {
      return { action, granted: false };
    }
    const requestId = crypto.randomUUID();
    const owner: PermissionOwner = { sessionId: ids.sessionId, taskId: ids.taskId };
    const expiresAt = new Date(Date.now() + PENDING_TIMEOUT_MS).toISOString();
    notify?.({ requestId, class: cls, target, sessionId: ids.sessionId, taskId: ids.taskId, expiresAt });
    this.audit.write("permission.asked", { class: cls, target, requestId }, ids);
    if (signal?.aborted) {
      return { action: "ask", granted: false };
    }
    const onAbort = () => this.pending.resolve(requestId, false);
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const approved = await this.pending.create(requestId, owner);
      this.audit.write("permission.resolved", { requestId, approved }, ids);
      return { action: "ask", granted: approved };
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  }
}
