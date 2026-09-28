import { describe, expect, it } from "bun:test";
import { PermissionEngine } from "../src/engine/core/permissions/engine";
import { canTransition } from "../src/engine/core/agent/orchestrator";
import { PendingPermissions } from "../src/engine/core/permissions/pending";
import { decideAction, defaultPolicyFile } from "../src/engine/core/permissions/policy";

describe("permission policy", () => {
  it("allows read by default and honours exec allow prefixes", () => {
    const policy = defaultPolicyFile();
    policy.tiers.exec.allow = ["git status", "bun test"];
    expect(decideAction(policy, "read", "any/path")).toBe("allow");
    expect(decideAction(policy, "exec", "git status")).toBe("allow");
    expect(decideAction(policy, "exec", "git status --short")).toBe("allow");
    expect(decideAction(policy, "exec", "gitpush")).toBe("ask");
    expect(decideAction(policy, "exec", "rm -rf /")).toBe("ask");
    expect(decideAction(policy, "write", "src/x.ts")).toBe("ask");
  });

  it("honours a deny default", () => {
    const policy = defaultPolicyFile();
    policy.tiers.destructive.default = "deny";
    expect(decideAction(policy, "destructive", "anything")).toBe("deny");
  });
});

describe("permission engine", () => {
  it("allows without consulting the pending queue", async () => {
    const asked: string[] = [];
    const audit = { write: () => {} };
    const pending = { create: async () => true, resolve: () => false };
    const engine = new PermissionEngine(defaultPolicyFile(), pending, audit);
    const decision = await engine.authorize("read", "x", {}, (request) => asked.push(request.target));
    expect(decision).toEqual({ action: "allow", granted: true });
    expect(asked).toEqual([]);
  });

  it("asks, notifies and resolves through the pending queue", async () => {
    const audit = { write: () => {} };
    const pending = new PendingPermissions();
    const engine = new PermissionEngine(defaultPolicyFile(), pending, audit);
    const requests: Array<{ requestId: string; target: string; preview?: string }> = [];

    const promise = engine.authorize("exec", "sudo nice", {}, (request) => requests.push(request));
    await Bun.sleep(2);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.target).toBe("sudo nice");
    expect(requests[0]?.requestId).toBeTruthy();
    expect(pending.resolve(requests[0]?.requestId ?? "", true)).toBe(true);
    const decision = await promise;
    expect(decision).toEqual({ action: "ask", granted: true });

    const denyPolicy = defaultPolicyFile();
    denyPolicy.tiers.exec.default = "deny";
    const denyEngine = new PermissionEngine(denyPolicy, pending, audit);
    const unrequested = await denyEngine.authorize("exec", "unknown flow", {}, () => {});
    expect(unrequested.granted).toBe(false);
  });
});

describe("orchestrator transitions", () => {
  it("allows only legal transitions", () => {
    expect(canTransition("idle", "planning")).toBe(true);
    expect(canTransition("planning", "executing")).toBe(true);
    expect(canTransition("executing", "verifying")).toBe(true);
    expect(canTransition("verifying", "completed")).toBe(true);
    expect(canTransition("executing", "failed")).toBe(true);
    expect(canTransition("completed", "executing")).toBe(false);
    expect(canTransition("idle", "completed")).toBe(false);
    expect(canTransition("failed", "executing")).toBe(false);
  });
});
