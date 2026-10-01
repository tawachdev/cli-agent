import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";

const MAX_LINK_HOPS = 8;

function realish(path: string, hops: number): string {
  let stat: ReturnType<typeof lstatSync> | undefined;
  try {
    stat = lstatSync(path);
  } catch {
    stat = undefined;
  }
  if (stat === undefined) {
    const parent = dirname(path);
    if (parent === path) return path;
    return join(realish(parent, hops), basename(path));
  }
  if (!stat.isSymbolicLink()) return realpathSync(path);
  if (hops <= 0) return path;
  const link = readlinkSync(path);
  return realish(resolve(dirname(path), link), hops - 1);
}

export function scopedPath(workspaceRoot: string, path: string): string | null {
  const root = realpathSync(resolve(workspaceRoot));
  const target = resolve(root, path);
  if (target !== root && !target.startsWith(root + sep)) return null;
  const real = realish(target, MAX_LINK_HOPS);
  if (real !== root && !real.startsWith(root + sep)) return null;
  return real;
}
