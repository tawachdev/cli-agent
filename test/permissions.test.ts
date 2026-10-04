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
    const pending = { create: async () => true, resolve: () => ({ ok: false }) };
    const engine = new PermissionEngine(defaultPolicyFile(), pending, audit);
    const decision = await engine.authorize("read", "x", {}, (request) => asked.push(request.target));
    expect(decision).toEqual({ action: "allow", granted: true });
    expect(asked).toEqual([]);
  });

  it("asks, notifies and resolves through the pending queue", async () => {
    const audit = { write: () => {} };
    const pending = new PendingPermissions();
    const engine = new PermissionEngine(defaultPolicyFile(), pending, audit);
    const requests: Array<{ requestId: string; target: string; sessionId?: string; taskId?: string }> = [];

    const promise = engine.authorize(
      "exec",
      "sudo nice",
      { sessionId: "s1", taskId: "t1" },
      (request) => requests.push(request),
    );
    await Bun.sleep(2);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.target).toBe("sudo nice");
    expect(requests[0]?.requestId).toBeTruthy();
    expect(requests[0]?.sessionId).toBe("s1");
    expect(requests[0]?.taskId).toBe("t1");
    expect(pending.resolve(requests[0]?.requestId ?? "", true, { sessionId: "s1", taskId: "t1" })).toMatchObject({
      ok: true,
    });
    const decision = await promise;
    expect(decision).toEqual({ action: "ask", granted: true });

    const denyPolicy = defaultPolicyFile();
    denyPolicy.tiers.exec.default = "deny";
    const denyEngine = new PermissionEngine(denyPolicy, pending, audit);
    const unrequested = await denyEngine.authorize("exec", "unknown flow", {}, () => {});
    expect(unrequested.granted).toBe(false);
  });
});

describe("pending permission ownership", () => {
  it("binds a request to its session and task", async () => {
    const pending = new PendingPermissions();
    const waiter = pending.create("req-1", { sessionId: "s1", taskId: "t1" });
    expect(pending.resolve("req-1", true, { sessionId: "s1", taskId: "t1" })).toMatchObject({ ok: true });
    expect(await waiter).toBe(true);
  });

  it("rejects resolution from a wrong session or task", async () => {
    const pending = new PendingPermissions(60_000);
    const waiter = pending.create("req-2", { sessionId: "s1", taskId: "t1" });
    expect(pending.resolve("req-2", true, { sessionId: "other", taskId: "t1" })).toMatchObject({
      ok: false,
      reason: "ownership",
    });
    expect(pending.resolve("req-2", true, { sessionId: "s1", taskId: "other" })).toMatchObject({
      ok: false,
      reason: "ownership",
    });
    expect(pending.resolve("req-2", true, { sessionId: "s1", taskId: "t1" })).toMatchObject({ ok: true });
    expect(await waiter).toBe(true);
  });

  it("rejects double resolution and unknown requests", async () => {
    const pending = new PendingPermissions();
    const waiter = pending.create("req-3", { sessionId: "s1" });
    expect(pending.resolve("req-3", true, { sessionId: "s1" })).toMatchObject({ ok: true });
    expect(pending.resolve("req-3", false, { sessionId: "s1" })).toMatchObject({ ok: false, reason: "unknown" });
    expect(pending.resolve("missing", true)).toMatchObject({ ok: false, reason: "unknown" });
    expect(await waiter).toBe(true);
  });

  it("expires pending requests and then reports unknown", async () => {
    const pending = new PendingPermissions(5);
    const waiter = pending.create("req-4", { sessionId: "s1" });
    await Bun.sleep(15);
    expect(pending.resolve("req-4", true, { sessionId: "s1" })).toMatchObject({ ok: false, reason: "unknown" });
    expect(await waiter).toBe(false);
  });
});


describe("exec allow-rule hardening", () => {
  const policy = defaultPolicyFile();

  it("still honours narrow, safe allow rules", () => {
    policy.tiers.exec.allow = ["git status", "bun test"];
    expect(decideAction(policy, "exec", "git status")).toBe("allow");
    expect(decideAction(policy, "exec", "git status --short")).toBe("allow");
    expect(decideAction(policy, "exec", "bun test")).toBe("allow");
  });

  it("honours exact interpreter pins but never interpreter prefixes", () => {
    policy.tiers.exec.allow = ["bun test src/x.test.ts", "node"];
    expect(decideAction(policy, "exec", "bun test src/x.test.ts")).toBe("allow");
    expect(decideAction(policy, "exec", "bun test src/other.test.ts")).toBe("ask");
    expect(decideAction(policy, "exec", "bun test src/x.test.ts --coverage")).toBe("ask");
    expect(decideAction(policy, "exec", "node")).toBe("ask");
  });

  it("never auto-allows bare interpreters", () => {
    policy.tiers.exec.allow = ["node", "python3", "bun"];
    expect(decideAction(policy, "exec", "node")).toBe("ask");
    expect(decideAction(policy, "exec", "node script.js")).toBe("ask");
    expect(decideAction(policy, "exec", "python3")).toBe("ask");
    expect(decideAction(policy, "exec", "bun run dev")).toBe("ask");
  });

  it("refuses interpreter prefixes even with plain arguments", () => {
    policy.tiers.exec.allow = ["node script.js", "bun run", "python3"];
    for (const command of [
      "node script.js extra",
      "node script.js -e require('child_process').execSync('id')",
      "bun run dev",
      "python3 script.py",
    ]) {
      expect(decideAction(policy, "exec", command)).toBe("ask");
    }
  });

  it("blocks shell metacharacter and substitution escapes in the suffix", () => {
    policy.tiers.exec.allow = ["git status"];
    for (const command of [
      "git status; rm -rf /",
      "git status && curl evil",
      "git status | sh",
      "git status $(curl evil)",
      "git status `id`",
      "git status > /etc/passwd",
      "git status < /etc/passwd",
      "git status $(reboot)",
      "git status (subshell)",
      "git status {a,b}",
    ]) {
      expect(decideAction(policy, "exec", command)).toBe("ask");
    }
  });

  it("ignores allow patterns that themselves carry metacharacters", () => {
    policy.tiers.exec.allow = ["git status; id"];
    expect(decideAction(policy, "exec", "git status; id")).toBe("ask");
  });
});

describe("orchestrator transitions", () => {
  it("allows only legal transitions", () => {
    expect(canTransition("idle", "executing")).toBe(true);
    expect(canTransition("executing", "verifying")).toBe(true);
    expect(canTransition("verifying", "completed")).toBe(true);
    expect(canTransition("verifying", "executing")).toBe(true);
    expect(canTransition("executing", "failed")).toBe(true);
    expect(canTransition("idle", "completed")).toBe(false);
    expect(canTransition("completed", "executing")).toBe(false);
    expect(canTransition("failed", "executing")).toBe(false);
    expect(canTransition("aborted", "executing")).toBe(false);
    expect(canTransition("completed", "failed")).toBe(false);
  });
});
