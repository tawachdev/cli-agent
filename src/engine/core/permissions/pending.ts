import { randomUUID } from "node:crypto";

export interface PermissionOwner {
  sessionId?: string;
  taskId?: string;
}

export type ResolveOutcome =
  | { ok: true; owner: PermissionOwner }
  | { ok: false; reason: "unknown" | "ownership" };

interface PendingEntry {
  owner: PermissionOwner;
  resolve: (approved: boolean) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class PendingPermissions {
  private readonly waiting = new Map<string, PendingEntry>();

  constructor(private readonly timeoutMs = 5 * 60 * 1000) {}

  create(requestId: string = randomUUID(), owner: PermissionOwner = {}): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => this.resolve(requestId, false), this.timeoutMs);
      timer.unref?.();
      this.waiting.set(requestId, { owner, resolve, timer });
    });
  }

  resolve(requestId: string, approved: boolean, claimed?: PermissionOwner): ResolveOutcome {
    const entry = this.waiting.get(requestId);
    if (!entry) return { ok: false, reason: "unknown" };
    if (claimed) {
      if ((claimed.sessionId ?? undefined) !== (entry.owner.sessionId ?? undefined)) {
        return { ok: false, reason: "ownership" };
      }
      if ((claimed.taskId ?? undefined) !== (entry.owner.taskId ?? undefined)) {
        return { ok: false, reason: "ownership" };
      }
    }
    this.waiting.delete(requestId);
    clearTimeout(entry.timer);
    entry.resolve(approved);
    return { ok: true, owner: entry.owner };
  }

  owner(requestId: string): PermissionOwner | undefined {
    return this.waiting.get(requestId)?.owner;
  }
}
