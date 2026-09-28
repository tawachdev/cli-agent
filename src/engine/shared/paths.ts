import { resolve, sep } from "node:path";

export function scopedPath(workspaceRoot: string, path: string): string | null {
  const root = resolve(workspaceRoot);
  const target = resolve(root, path);
  if (target !== root && !target.startsWith(root + sep)) return null;
  return target;
}
