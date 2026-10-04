export type CheckStatus = "passed" | "failed" | "aborted" | "timedout";

export interface CheckResult {
  status: CheckStatus;
  ok: boolean;
  output: string;
  exitCode: number | null;
}

const MAX_OUTPUT = 16 * 1024;
const MAX_BUFFER = 32 * 1024;
const TIMEOUT_MS = 120_000;
const KILL_GRACE_MS = 2_000;

async function readCapped(stream: ReadableStream<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  let out = "";
  let capped = false;
  for await (const chunk of stream) {
    if (capped) continue;
    out += decoder.decode(chunk, { stream: true });
    if (out.length >= MAX_BUFFER) {
      out = out.slice(0, MAX_BUFFER);
      capped = true;
    }
  }
  if (!capped) out += decoder.decode();
  return out;
}

async function terminate(proc: ReturnType<typeof Bun.spawn>): Promise<void> {
  if (proc.exitCode !== null) return;
  proc.kill();
  const forceKill = setTimeout(() => proc.kill("SIGKILL"), KILL_GRACE_MS);
  forceKill.unref?.();
  await proc.exited;
  clearTimeout(forceKill);
}

export async function runCheck(
  command: string,
  cwd: string,
  signal?: AbortSignal,
  timeoutMs: number = TIMEOUT_MS,
): Promise<CheckResult> {
  if (signal?.aborted) {
    return { status: "aborted", ok: false, output: "check aborted before start", exitCode: null };
  }
  const proc = Bun.spawn(["sh", "-c", command], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  let timedOut = false;
  const abort = () => terminate(proc);
  signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    void terminate(proc);
  }, timeoutMs);
  timer.unref?.();
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      readCapped(proc.stdout),
      readCapped(proc.stderr),
      proc.exited,
    ]);
    const output = (stdout + "\n" + stderr).trim();
    if (signal?.aborted) {
      return { status: "aborted", ok: false, output, exitCode };
    }
    if (timedOut) {
      return { status: "timedout", ok: false, output: output + "\n... (check timed out)", exitCode };
    }
    return {
      status: exitCode === 0 ? "passed" : "failed",
      ok: exitCode === 0,
      output: output.length > MAX_OUTPUT ? output.slice(0, MAX_OUTPUT) + "\n... (truncated)" : output,
      exitCode,
    };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}
