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
  const primary = join(workspaceRoot, ".agent", "permissions.json");
  const legacy = join(workspaceRoot, ".agent", "permissions.json");
  const path = existsSync(primary) ? primary : existsSync(legacy) ? legacy : null;
  if (path === null) return defaultPolicyFile();
  const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
  return policySchema.parse(raw);
}

export function decideAction(policy: PolicyFile, cls: PermissionClass, target: string): PermissionAction {
  const tier = policy.tiers[cls];
  if (tier.allow.some((pattern) => target === pattern || target.startsWith(pattern + " "))) {
    return "allow";
  }
  return tier.default;
}
