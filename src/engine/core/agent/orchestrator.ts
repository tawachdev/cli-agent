export type TaskState =
  | "idle"
  | "planning"
  | "executing"
  | "verifying"
  | "completed"
  | "failed"
  | "aborted";

const legal: Record<TaskState, TaskState[]> = {
  idle: ["planning", "failed", "aborted"],
  planning: ["executing", "failed", "aborted"],
  executing: ["executing", "verifying", "completed", "failed", "aborted"],
  verifying: ["completed", "failed", "executing", "aborted"],
  completed: [],
  failed: [],
  aborted: [],
};

export function canTransition(from: TaskState, to: TaskState): boolean {
  return legal[from].includes(to);
}
