import { guard, readCapped, spawnShell } from "../../shared/proc";

export type CheckStatus = "passed" | "failed" | "aborted" | "timedout";

export interface CheckResult {
  status: CheckStatus;
  ok: boolean;
  output: string;
  exitCode: number | null;
}

const MAX_OUTPUT = 16 * 1024;
const TIMEOUT_MS = 120_000;

export async function runCheck(
  command: string,
  cwd: string,
  signal?: AbortSignal,
  timeoutMs: number = TIMEOUT_MS,
): Promise<CheckResult> {
  if (signal?.aborted) {
    return { status: "aborted", ok: false, output: "check aborted before start", exitCode: null };
  }
  const proc = spawnShell(command, cwd);
  const stop = guard(proc, signal, timeoutMs);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([readCapped(proc.stdout), readCapped(proc.stderr), proc.exited]);
    const output = (stdout.text + "\n" + stderr.text).trim();
    if (signal?.aborted) {
      return { status: "aborted", ok: false, output, exitCode };
    }
    if (stop.timedOut()) {
      return { status: "timedout", ok: false, output: output + "\n... (check timed out)", exitCode };
    }
    return {
      status: exitCode === 0 ? "passed" : "failed",
      ok: exitCode === 0,
      output: output.length > MAX_OUTPUT ? output.slice(0, MAX_OUTPUT) + "\n... (truncated)" : output,
      exitCode,
    };
  } finally {
    stop.release();
  }
}
