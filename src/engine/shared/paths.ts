import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";

const MAX_LINK_HOPS = 8;

function resolveRealPath(path: string, hops: number): string | null {
  let stat: ReturnType<typeof lstatSync> | undefined;
  try {
    stat = lstatSync(path);
  } catch {
    stat = undefined;
  }
  if (stat === undefined) {
    const parent = dirname(path);
    if (parent === path) return path;
    const resolvedParent = resolveRealPath(parent, hops);
    return resolvedParent === null ? null : join(resolvedParent, basename(path));
  }
  if (!stat.isSymbolicLink()) return realpathSync(path);
  if (hops <= 0) return null;
  const link = readlinkSync(path);
  return resolveRealPath(resolve(dirname(path), link), hops - 1);
}

export function scopedPath(workspaceRoot: string, path: string): string | null {
  const root = realpathSync(resolve(workspaceRoot));
  const target = resolve(root, path);
  if (target !== root && !target.startsWith(root + sep)) return null;
  const real = resolveRealPath(target, MAX_LINK_HOPS);
  if (real === null) return null;
  if (real !== root && !real.startsWith(root + sep)) return null;
  return real;
}
