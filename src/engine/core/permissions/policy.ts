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

const SHELL_META = /[;&|`$\n><(){}"']/;

const INTERPRETERS = new Set([
  "node",
  "nodejs",
  "python",
  "python3",
  "ruby",
  "perl",
  "php",
  "bash",
  "sh",
  "zsh",
  "fish",
  "dash",
  "ksh",
  "bun",
  "deno",
  "osascript",
  "env",
  "xargs",
  "eval",
  "exec",
  "source",
]);

function executableOf(command: string): string {
  const first = command.trim().split(/\s+/)[0] ?? "";
  return first.split("/").pop() ?? first;
}

function matchesAllow(pattern: string, target: string, cls: PermissionClass): boolean {
  if (SHELL_META.test(pattern)) return false;
  if (cls === "exec" && INTERPRETERS.has(executableOf(pattern))) {
    // interpreters execute arbitrary code from their arguments — only an exact,
    // fully pinned command (never a bare interpreter) may auto-run
    const pinned = pattern.trim().split(/\s+/).length >= 2;
    return pinned && target === pattern;
  }
  if (target === pattern) return true;
  if (cls === "exec") {
    if (!target.startsWith(pattern + " ")) return false;
    const remainder = target.slice(pattern.length + 1);
    return !SHELL_META.test(remainder);
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
