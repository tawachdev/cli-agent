import { randomUUID } from "node:crypto";

export class PendingPermissions {
  private readonly waiting = new Map<string, (approved: boolean) => void>();

  create(requestId: string = randomUUID()): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      this.waiting.set(requestId, resolve);
      setTimeout(() => this.resolve(requestId, false), 5 * 60 * 1000).unref?.();
    });
  }

  resolve(requestId: string, approved: boolean): boolean {
    const resolve = this.waiting.get(requestId);
    if (!resolve) return false;
    this.waiting.delete(requestId);
    resolve(approved);
    return true;
  }
}
