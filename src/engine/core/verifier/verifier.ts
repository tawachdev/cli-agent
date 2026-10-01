export interface CheckResult {
  ok: boolean;
  output: string;
}

const MAX_OUTPUT = 16 * 1024;
const MAX_BUFFER = 32 * 1024;
const TIMEOUT_MS = 120_000;

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

export async function runCheck(command: string, cwd: string, signal?: AbortSignal): Promise<CheckResult> {
  if (signal?.aborted) {
    return { ok: false, output: "check aborted before start" };
  }
  const proc = Bun.spawn(["sh", "-c", command], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  const abort = () => proc.kill();
  signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => proc.kill(), TIMEOUT_MS);
  timer.unref?.();
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      readCapped(proc.stdout),
      readCapped(proc.stderr),
      proc.exited,
    ]);
    const output = (stdout + "\n" + stderr).trim();
    return {
      ok: exitCode === 0,
      output: output.length > MAX_OUTPUT ? output.slice(0, MAX_OUTPUT) + "\n... (truncated)" : output,
    };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}
