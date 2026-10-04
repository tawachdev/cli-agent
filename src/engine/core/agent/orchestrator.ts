export type TaskState =
  | "idle"
  | "executing"
  | "verifying"
  | "completed"
  | "failed"
  | "aborted";

const legal: Record<TaskState, TaskState[]> = {
  idle: ["executing", "failed", "aborted"],
  executing: ["verifying", "completed", "failed", "aborted"],
  verifying: ["completed", "failed", "executing", "aborted"],
  completed: [],
  failed: [],
  aborted: [],
};

export function canTransition(from: TaskState, to: TaskState): boolean {
  return legal[from].includes(to);
}

export class IllegalTransitionError extends Error {
  constructor(
    readonly from: TaskState,
    readonly to: TaskState,
  ) {
    super(`illegal task state transition: ${from} -> ${to}`);
  }
}
