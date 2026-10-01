import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { PermissionClass } from "../../tools/types";

export type PermissionAction = "allow" | "ask" | "deny";

const tierSchema = z.object({
  default: z.enum(["allow", "ask", "deny"]),
  allow: z.array(z.string()).default([]),
});

const policySchema = z.object({
  version: z.number(),
  tiers: z.object({
    read: tierSchema,
    write: tierSchema,
    exec: tierSchema,
    destructive: tierSchema,
  }),
});

export type PolicyFile = z.infer<typeof policySchema>;

export function defaultPolicyFile(): PolicyFile {
  return {
    version: 1,
    tiers: {
      read: { default: "allow", allow: [] },
      write: { default: "ask", allow: [] },
      exec: { default: "ask", allow: [] },
      destructive: { default: "ask", allow: [] },
    },
  };
}

export function loadPolicy(workspaceRoot: string): PolicyFile {
  const path = join(workspaceRoot, ".agent", "permissions.json");
  if (!existsSync(path)) return defaultPolicyFile();
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return policySchema.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn("[permissions] invalid permissions.json, using defaults:", message);
    return defaultPolicyFile();
  }
}

const SHELL_META = /[;&|`$\n><]/;

function matchesAllow(pattern: string, target: string, cls: PermissionClass): boolean {
  if (target === pattern) return true;
  if (cls === "exec") {
    if (!target.startsWith(pattern + " ")) return false;
    return !SHELL_META.test(target.slice(pattern.length + 1));
  }
  return target.startsWith(pattern.endsWith("/") ? pattern : pattern + "/");
}

export function decideAction(policy: PolicyFile, cls: PermissionClass, target: string): PermissionAction {
  const tier = policy.tiers[cls];
  if (tier.allow.some((pattern) => matchesAllow(pattern, target, cls))) {
    return "allow";
  }
  return tier.default;
}
