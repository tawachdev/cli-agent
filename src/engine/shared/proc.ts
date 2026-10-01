const DEFAULT_MAX_BYTES = 32 * 1024;
const DEFAULT_TIMEOUT_MS = 120_000;

export interface ProcResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

async function readCapped(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
  buf: { text: string },
): Promise<void> {
  const decoder = new TextDecoder();
  for await (const chunk of stream) {
    if (buf.text.length < maxBytes) {
      buf.text += decoder.decode(chunk, { stream: true });
    }
  }
  buf.text += decoder.decode();
}

export async function runProc(
  args: string[],
  opts: { cwd: string; signal?: AbortSignal; timeoutMs?: number },
): Promise<ProcResult> {
  if (opts.signal?.aborted) {
    return { exitCode: -1, stdout: "", stderr: "aborted before start" };
  }
  const proc = Bun.spawn(args, { cwd: opts.cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const abort = () => proc.kill();
  opts.signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => proc.kill(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  timer.unref?.();
  const out = { text: "" };
  const err = { text: "" };
  try {
    const readers = [readCapped(proc.stdout, DEFAULT_MAX_BYTES, out), readCapped(proc.stderr, DEFAULT_MAX_BYTES, err)];
    const exitCode = await proc.exited;
    await Promise.allSettled(readers);
    return { exitCode, stdout: out.text, stderr: err.text };
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", abort);
  }
}
