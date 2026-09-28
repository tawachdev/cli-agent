import { stdout } from "node:process";
import { brandName } from "../shared/brand";
import { toDataUrl } from "../shared/images";
import type { ModelRole } from "../shared/types";
import { renderImage, type LoadedImage } from "./images";
import { C, chip, fit, fmtSecs, meter, panel, WIDTH, wrap, type Tty } from "./tui";

const rawUrl = process.env.AGENT_URL ?? "http://127.0.0.1:7800";
const baseUrl = new URL(rawUrl);
const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);

function assertLocal(url: URL): void {
  if ((url.protocol !== "http:" && url.protocol !== "https:") || !LOOPBACK.has(url.hostname)) {
    throw new Error("refusing non-loopback backend: " + url.hostname);
  }
}
assertLocal(baseUrl);

export const backendOrigin = baseUrl.origin;

interface StreamEvent {
  type: string;
  payload: Record<string, unknown>;
}

async function request(path: string, body?: unknown, method?: "POST" | "PUT" | "DELETE"): Promise<Record<string, unknown>> {
  const url = new URL(path, baseUrl);
  if (url.origin !== baseUrl.origin) {
    throw new Error("refusing cross-origin request path");
  }
  assertLocal(url);
  const response = await fetch(url, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "error",
  });
  return (await response.json()) as Record<string, unknown>;
}

export interface ProviderInfo {
  name: string;
  kind: "openai" | "anthropic";
  baseUrl: string;
  models: string[];
  keySet: boolean;
}

export interface RoleBinding {
  role: string;
  model: string;
  source: "env" | "file" | "default";
}

export const getProviders = (): Promise<ProviderInfo[]> =>
  request("/providers").then((r) => r["providers"] as ProviderInfo[]);

export const getBindings = (): Promise<RoleBinding[]> =>
  request("/models").then((r) => r["roles"] as RoleBinding[]);

export const putProviderKey = (name: string, key: string): Promise<Record<string, unknown>> =>
  request(`/providers/${name}/key`, { key }, "PUT");

export const deleteProviderKey = (name: string): Promise<Record<string, unknown>> =>
  request(`/providers/${name}/key`, {}, "DELETE");

export const testProvider = (name: string, model: string): Promise<Record<string, unknown>> =>
  request(`/providers/${name}/test`, { model }, "POST");

export const putBinding = (role: string, binding: string): Promise<Record<string, unknown>> =>
  request(`/models/${role}`, { binding }, "PUT");

export const addProvider = (body: { name: string; kind: "openai"; baseUrl: string; models: string[] }): Promise<Record<string, unknown>> =>
  request("/providers", body, "POST");

export const getSetupStatus = (): Promise<{ needsSetup: boolean }> =>
  request("/setup").then((r) => ({ needsSetup: r["needsSetup"] === true }));

export const skipSetup = (): Promise<Record<string, unknown>> =>
  request("/setup/skip", {}, "POST");

export interface BrandInfo {
  name: string;
  colors: [string, string];
  source: string;
}

export const getBrand = (): Promise<BrandInfo> =>
  request("/brand").then((r) => ({
    name: String(r["name"] ?? "MIMON"),
    colors: (r["colors"] as [string, string]) ?? ["teal", "gold"],
    source: String(r["source"] ?? "default"),
  }));

export const putBrand = (body: { name?: string; colors?: [string, string]; reset?: boolean }): Promise<Record<string, unknown>> =>
  request("/brand", body, "PUT");

const TOOL_ICON: Record<string, string> = {
  "fs.read": "▤",
  "fs.list": "▦",
  "fs.write": "✎",
  "fs.edit": "✎",
  "search.grep": "⌕",
  "git.status": "⎇",
  "git.diff": "⎇",
  "shell.exec": "▸",
};

let numCtx = 16384;

export class Chat {
  role: ModelRole = "mimon2";
  ctxPct = 0;
  steps = 0;
  sessionId = "";
  tokensPerSec: number | null = null;
  private ws: WebSocket | null = null;
  private readonly allows = new Set<string>();
  private streaming = false;
  private chipOpen = false;
  private toolStart = 0;
  private lastTool = "";
  private lastToolMs = 0;
  private stateLabel = "IDLE";

  constructor(
    private readonly tty: Tty,
    public permissionAsk: () => Promise<"a" | "v" | "n">,
  ) {}

  async connect(): Promise<void> {
    const wsUrl = new URL(baseUrl.toString());
    wsUrl.protocol = baseUrl.protocol === "https:" ? "wss:" : "ws:";
    wsUrl.pathname = "/sessions/" + this.sessionId + "/stream";
    const ws = new WebSocket(wsUrl.toString());
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve());
      ws.addEventListener("error", () => reject(new Error("backend ws failed - run: bun run dev")));
    });
    ws.addEventListener("message", (m) => {
      try {
        this.onEvent(JSON.parse(m.data as string) as StreamEvent).catch((error: Error) => {
          stdout.write(C.red + "  ✘ event failed: " + error.message + C.reset + "\n");
        });
      } catch (error) {
        stdout.write(C.red + "  ✘ bad event: " + (error as Error).message + C.reset + "\n");
      }
    });
    this.ws = ws;
  }

  async newSession(title?: string): Promise<void> {
    const result = await request("/sessions", title ? { title } : {});
    this.sessionId = (result["session"] as { id: string }).id;
  }

  async healthCheck(): Promise<void> {
    const health = await request("/health");
    if (!health["ok"]) throw new Error("unhealthy");
    numCtx = Number(health["numCtx"] ?? 16384);
  }

  private printDashboard(): void {
    const ctx = meter(this.ctxPct);
    const tps = this.tokensPerSec !== null ? C.gold + this.tokensPerSec.toFixed(1) + " tok/s" + C.reset + "  " : "";
    const tool = this.lastTool
      ? C.dim + "last " + C.reset + this.lastTool + (this.lastToolMs ? C.dim + " " + fmtSecs(this.lastToolMs) + C.reset : "") + "  "
      : "";
    this.tty.write(fit(
      "  " + chip(this.stateLabel, this.stateLabel === "DONE") + " " +
      C.dim + "steps " + C.reset + this.steps + "  " +
      C.dim + "ctx " + C.reset + ctx + " " + this.ctxPct + "%  " +
      tps + tool + "\n",
    ));
  }

  private chipClose(): void {
    if (this.chipOpen) {
      this.tty.write(C.reset + "\n");
      this.chipOpen = false;
    }
  }

  private async onEvent(event: StreamEvent): Promise<void> {
    const p = event.payload;
    switch (event.type) {
      case "plan.updated": {
        this.chipClose();
        const lines = wrap(String(p.plan ?? ""), WIDTH() - 10).map((l) => "  " + l);
        panel(this.tty, "plan", C.gold, C.slate, lines);
        break;
      }
      case "token.delta": {
        if (!this.streaming) {
          this.chipClose();
          this.tty.write(C.gold + C.bold + "  ✦ " + brandName().toLowerCase() + " " + C.reset + C.dim + "─".repeat(Math.max(4, WIDTH() - 12)) + C.reset + "\n" + C.cream + "  ");
          this.streaming = true;
          this.stateLabel = "RESPONDING";
        }
        this.tty.write(p["text"] as string);
        break;
      }
      case "message.completed":
        if (this.streaming) {
          this.tty.write(C.reset + "\n");
          this.streaming = false;
        }
        break;
      case "tool.requested": {
        this.chipClose();
        if (this.streaming) this.streaming = false;
        this.toolStart = Date.now();
        const args = JSON.stringify(p["arguments"] ?? {});
        const short = args.length > WIDTH() - 30 ? args.slice(0, WIDTH() - 33) + "..." : args;
        this.tty.write(
          "  " + C.teal + (TOOL_ICON[String(p.name)] ?? "◆") + C.reset + " " +
          C.bold + String(p.name) + C.reset + C.dim + " " + short + C.reset + " ",
        );
        this.chipOpen = true;
        break;
      }
      case "tool.result": {
        const ms = Date.now() - this.toolStart;
        this.lastTool = String(p["name"] ?? "");
        this.lastToolMs = ms;
        const ok = p["ok"] === true;
        this.tty.write(
          ok
            ? C.green + `  ✔ ok ${fmtSecs(ms)}` + C.reset
            : C.red + `  ✘ ${fmtSecs(ms)} ` + (p["error"] as string ?? "failed") + C.reset,
        );
        this.tty.write("\n");
        this.chipOpen = false;
        this.printDashboard();
        break;
      }
      case "permission.requested":
        await this.handlePermission(p);
        break;
      case "usage": {
        const tokens = Number(p["completionTokens"] ?? 0);
        const ns = Number(p["evalDurationNs"] ?? 0);
        if (ns > 0) this.tokensPerSec = tokens / (ns / 1e9);
        const prompt = Number(p["promptTokens"] ?? 0);
        if (prompt > 0 && numCtx > 0) this.ctxPct = Math.min(100, Math.round((prompt / numCtx) * 100));
        break;
      }
      case "verify.result":
        this.tty.write(
          p["ok"] === true
            ? C.green + "  ✔ verified" + C.reset + C.dim + "  " + p["command"] + C.reset + "\n"
            : C.red + "  ✘ verify FAILED" + C.reset + C.dim + "  " + p["command"] + C.reset + "\n",
        );
        break;
      case "turn.completed":
        this.steps = Number(p["steps"] ?? 0);
        this.chipClose();
        this.stateLabel = "DONE";
        this.printDashboard();
        break;
      case "turn.failed":
        this.chipClose();
        this.tty.write(C.red + "  ✘ failed: " + (p["reason"] ?? "") + "\n" + C.reset);
        break;
      case "turn.aborted":
        this.chipClose();
        this.tty.write(C.red + "  ✘ aborted\n" + C.reset);
        break;
      case "context.compacted":
        this.tty.write(C.dim + "  · context compacted ·\n" + C.reset);
        break;
      default:
        break;
    }
  }

  private async handlePermission(p: Record<string, unknown>): Promise<void> {
    this.chipClose();
    if (this.streaming) this.streaming = false;
    this.tty.write("\n" + C.inverse + C.gold + C.bold + " ⛨ PERMISSION " + C.reset + C.dim + " " + (p["class"] as string) + C.reset + "\n");
    this.tty.write(C.bold + "  " + (p["target"] as string) + C.reset + "\n");
    const preview = p["preview"] as string | undefined;
    if (preview) {
      const box = WIDTH() - 6;
      for (const line of wrap(preview, box).slice(0, 16)) {
        const colored = line.startsWith("+") ? C.green + line : line.startsWith("-") ? C.red + line : C.dim + line;
        this.tty.write("  " + colored + C.reset + "\n");
      }
    }
    const target = p["target"] as string;
    let approved = false;
    if (this.isAllowed(target)) {
      approved = true;
      this.tty.write(C.dim + "  (allowed earlier this session)\n" + C.reset);
    } else {
      const answer = await this.permissionAsk();
      approved = answer !== "n";
      if (answer === "v") this.allows.add(target);
    }
    await request("/agent/permissions", {
      requestId: String(p["requestId"] ?? ""),
      approved,
      sessionId: this.sessionId,
    });
    this.tty.write(C.dim + (approved ? "  · allowed ·\n" : "  · denied ·\n") + C.reset);
  }

  private isAllowed(target: string): boolean {
    for (const a of this.allows) {
      if (target === a || target.startsWith(a + " ")) return true;
    }
    return false;
  }

  async run(task: string, images: LoadedImage[] = []): Promise<void> {
    this.lastTool = "";
    const tag = images.length > 0 ? C.dim + "  +" + images.length + " image" + (images.length > 1 ? "s" : "") + C.reset : "";
    this.tty.write(C.inverse + C.bold + " YOU " + C.reset + " " + task + tag + "\n");
    for (const image of images) renderImage(this.tty, image);
    const payload: Record<string, unknown> = { sessionId: this.sessionId, task, role: this.role };
    if (images.length > 0) payload["images"] = images.map((image) => toDataUrl(image.mime, image.base64));
    const result = await request("/agent/run", payload);
    if (!result["ok"]) {
      const message = String(result["error"] ?? "unknown");
      if (!message.includes("aborted")) {
        this.tty.write(C.red + "  ✘ " + message + "\n" + C.reset);
      }
      this.printDashboard();
    }
  }

  async abort(): Promise<void> {
    await request("/agent/abort", { sessionId: this.sessionId });
  }

  close(): void {
    this.ws?.close(1000);
  }
}
