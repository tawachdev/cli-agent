const DEFAULT_MAX_CHARS = 32 * 1024;
const DEFAULT_TIMEOUT_MS = 120_000;
const KILL_GRACE_MS = 2_000;

export type Child = Bun.Subprocess<"ignore", "pipe", "pipe">;

export interface ProcResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export async function readCapped(
  stream: ReadableStream<Uint8Array>,
  maxChars: number = DEFAULT_MAX_CHARS,
): Promise<{ text: string; truncated: boolean }> {
  const decoder = new TextDecoder();
  let text = "";
  let truncated = false;
  for await (const chunk of stream) {
    if (truncated) continue;
    text += decoder.decode(chunk, { stream: true });
    if (text.length >= maxChars) {
      text = text.slice(0, maxChars);
      truncated = true;
    }
  }
  if (!truncated) text += decoder.decode();
  return { text, truncated };
}

export function spawnShell(command: string, cwd: string): Child {
  return Bun.spawn(["sh", "-c", command], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    detached: true,
  });
}

function signalGroup(proc: Child, signal: NodeJS.Signals): void {
  try {
    process.kill(-proc.pid, signal);
  } catch {}
}

export async function stopTree(proc: Child, graceMs: number = KILL_GRACE_MS): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  signalGroup(proc, "SIGTERM");
  const force = setTimeout(() => signalGroup(proc, "SIGKILL"), graceMs);
  force.unref?.();
  await proc.exited;
  clearTimeout(force);
}

export function guard(proc: Child, signal: AbortSignal | undefined, timeoutMs: number): {
  timedOut: () => boolean;
  release: () => void;
} {
  let timedOut = false;
  const abort = () => void stopTree(proc);
  signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    void stopTree(proc);
  }, timeoutMs);
  timer.unref?.();
  return {
    timedOut: () => timedOut,
    release: () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    },
  };
}

export async function runProc(
  args: string[],
  opts: { cwd: string; signal?: AbortSignal; timeoutMs?: number },
): Promise<ProcResult> {
  if (opts.signal?.aborted) {
    return { exitCode: -1, stdout: "", stderr: "aborted before start" };
  }
  const proc = Bun.spawn(args, { cwd: opts.cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore", detached: true });
  const stop = guard(proc, opts.signal, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([readCapped(proc.stdout), readCapped(proc.stderr), proc.exited]);
    return { exitCode, stdout: stdout.text, stderr: stderr.text };
  } finally {
    stop.release();
  }
}
