export interface CheckResult {
  ok: boolean;
  output: string;
}

const MAX_OUTPUT = 16 * 1024;

export async function runCheck(command: string, cwd: string, signal?: AbortSignal): Promise<CheckResult> {
  const proc = Bun.spawn(["sh", "-c", command], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  const abort = () => proc.kill();
  signal?.addEventListener("abort", abort, { once: true });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  signal?.removeEventListener("abort", abort);
  const output = (stdout + "\n" + stderr).trim();
  return {
    ok: exitCode === 0,
    output: output.length > MAX_OUTPUT ? output.slice(0, MAX_OUTPUT) + "\n... (truncated)" : output,
  };
}
