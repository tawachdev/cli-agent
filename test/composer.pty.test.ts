// The real CLI in a real pseudo-terminal, end to end: it boots its own engine,
// talks to a fake OpenAI-compatible provider, and we paste an image into it.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPng } from "./helpers/png";

const ROOT = join(import.meta.dir, "..");
const KEY = "sk-composer-pty";
const python = Bun.which("python3");

let provider: ReturnType<typeof Bun.serve> | null = null;
let workspace = "";
const imagesSeen: number[] = [];

beforeAll(() => {
  provider = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (request.headers.get("authorization") !== "Bearer " + KEY) {
        return Response.json({ error: { message: "invalid api key" } }, { status: 401 });
      }
      const body = (await request.json().catch(() => ({}))) as { messages?: Array<{ content?: unknown }> };
      const images = (body.messages ?? [])
        .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
        .filter((part) => (part as { type?: string }).type === "image_url").length;
      imagesSeen.push(images);
      const chunks = ["I see ", "a teal ", "gradient."].map((content) => "data: " + JSON.stringify({ choices: [{ delta: { content } }] }) + "\n\n");
      chunks.push("data: " + JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 9, completion_tokens: 3 } }) + "\n\n");
      chunks.push("data: [DONE]\n\n");
      return new Response(chunks.join(""), { headers: { "content-type": "text/event-stream" } });
    },
  });
  workspace = mkdtempSync(join(tmpdir(), "mimon-composer-pty-"));
  mkdirSync(join(workspace, ".agent"), { recursive: true });
  writeFileSync(
    join(workspace, ".agent", "providers.json"),
    JSON.stringify([{ name: "mockeye", kind: "openai", baseUrl: `http://127.0.0.1:${provider.port}`, models: ["mock-vision"] }]),
  );
  const binding = "mockeye/mock-vision";
  writeFileSync(
    join(workspace, ".agent", "models.json"),
    JSON.stringify({ coder: binding, general: binding, mimon1: binding, mimon2: binding, mimon3: binding, mimonMax: binding }),
  );
  writeFileSync(join(workspace, "shot.png"), buildPng(120, 60, (x, y) => [0, 120 + (x % 100), 100 + (y % 120)]));
});

afterAll(() => {
  provider?.stop(true);
  rmSync(workspace, { recursive: true, force: true });
});

describe.skipIf(!python || process.platform === "win32")("composer in a real terminal", () => {
  for (const mode of ["iterm", "kitty", "plain"]) {
    it(`pastes, explains and sends an image (${mode})`, async () => {
      const port = 20000 + Math.floor(Math.random() * 20000);
      const run = Bun.spawn(
        [python!, join(ROOT, "scripts", "pty-composer.py"), process.execPath, join(ROOT, "bin", "agent.ts"), workspace, String(port), join(workspace, "shot.png"), mode],
        { env: { ...process.env, AGENT_KEY_MOCKEYE: KEY }, stdout: "pipe", stderr: "pipe" },
      );
      const [out, err, code] = await Promise.all([new Response(run.stdout).text(), new Response(run.stderr).text(), run.exited]);
      if (code !== 0) console.log(out + err);
      expect(out).toContain("RESULT: PASS");
      expect(code).toBe(0);
      expect(imagesSeen.at(-1)).toBe(1);
    }, 120_000);
  }
});

describe.skipIf(!python || process.platform === "win32")("resize storm in a real terminal", () => {
  it("keeps exactly one box through nine resizes", async () => {
    const run = Bun.spawn([python!, join(ROOT, "scripts", "pty-resize-test.py"), process.execPath], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
    const [out, code] = await Promise.all([new Response(run.stdout).text(), run.exited]);
    if (code !== 0) console.log(out);
    expect(out).toContain("RESULT: PASS");
  }, 120_000);
});
