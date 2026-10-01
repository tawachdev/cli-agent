import { randomUUID } from "node:crypto";

export class PendingPermissions {
  private readonly waiting = new Map<string, (approved: boolean) => void>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  create(requestId: string = randomUUID()): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      this.waiting.set(requestId, resolve);
      const timer = setTimeout(() => this.resolve(requestId, false), 5 * 60 * 1000);
      timer.unref?.();
      this.timers.set(requestId, timer);
    });
  }

  resolve(requestId: string, approved: boolean): boolean {
    const resolve = this.waiting.get(requestId);
    if (!resolve) return false;
    this.waiting.delete(requestId);
    const timer = this.timers.get(requestId);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(requestId);
    }
    resolve(approved);
    return true;
  }
}
