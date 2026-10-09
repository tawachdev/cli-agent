import { stdout } from "node:process";
import { brandName } from "../shared/brand";
import { toDataUrl } from "../shared/images";
import type { ModelRole } from "../shared/types";
import type { LoadedImage } from "./images";
import { C, chip, fit, fmtSecs, meter, panel, WIDTH, wrap, type Tty } from "./tui";

const rawUrl = process.env.AGENT_URL ?? `http://127.0.0.1:${process.env.AGENT_PORT ?? "7800"}`;
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

export function wizardModelCandidates(fallback: string, live: string[]): string[] {
  const seen = new Set<string>();
  return [fallback, ...live].filter((model) => {
    if (!model || seen.has(model)) return false;
    seen.add(model);
    return true;
  });
}

export function looksLikeModelMissing(message: string): boolean {
  return /\b404\b/.test(message) || message.toLowerCase().includes("not found");
}

export function keylessProviderBindings(
  roles: RoleBinding[],
  providers: ProviderInfo[],
): Array<{ role: string; provider: string }> {
  const noKey = new Set(providers.filter((p) => !p.keySet).map((p) => p.name));
  const out: Array<{ role: string; provider: string }> = [];
  for (const role of roles) {
    const slash = role.model.indexOf("/");
    if (slash <= 0) continue;
    const provider = role.model.slice(0, slash);
    if (noKey.has(provider)) out.push({ role: role.role, provider });
  }
  return out;
}

export const getProviders = (): Promise<ProviderInfo[]> =>
  request("/providers").then((r) => r["providers"] as ProviderInfo[]);

export const getProviderModels = (name: string): Promise<string[]> =>
  request(`/providers/${name}/models`).then((r) => (r["models"] as string[]) ?? []);

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

export interface BrandInfo {
  name: string;
  colors: string[];
  customColors: string[];
  source: string;
}

export const getBrand = (): Promise<BrandInfo> =>
  request("/brand").then((r) => ({
    name: String(r["name"] ?? "MIMON"),
    colors: (r["colors"] as string[]) ?? ["teal", "gold"],
    customColors: (r["customColors"] as string[]) ?? [],
    source: String(r["source"] ?? "default"),
  }));

export const putBrand = (body: { name?: string; colors?: string[]; reset?: boolean }): Promise<Record<string, unknown>> =>
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
  private wsGeneration = 0;
  private readonly allows = new Set<string>();
  private streaming = false;
  private chipOpen = false;
  private toolStart = 0;
  private lastTool = "";
  private lastToolMs = 0;
  private stateLabel = "IDLE";
  private lastFailure = "";
  private failureShown = false;
  private awaitingRun = false;
  uiHandlesErrors = false;
  lastWasStream = false;
  ui: {
    printAbove(lines: string[]): void;
    stream(text: string): void;
    streamStart(): void;
    streamEnd(): void;
    replaceLast(line: string): void;
    setStatus(state: string, steps: number): void;
  } | null = null;
  onError: (message: string) => void = (message) => {
    if (!this.uiHandlesErrors) this.tty.write(C.red + "  ✘ " + message + "\n" + C.reset);
  };

  constructor(
    private readonly tty: Tty,
    public permissionAsk: () => Promise<"a" | "v" | "n">,
  ) {}

  async connect(): Promise<void> {
    this.ws?.close();
    this.wsGeneration += 1;
    const generation = this.wsGeneration;
    const wsUrl = new URL(baseUrl.toString());
    wsUrl.protocol = baseUrl.protocol === "https:" ? "wss:" : "ws:";
    wsUrl.pathname = "/sessions/" + this.sessionId + "/stream";
    const ws = new WebSocket(wsUrl.toString());
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve());
      ws.addEventListener("error", () => reject(new Error("backend ws failed - run: bun run dev")));
    });
    ws.addEventListener("message", (m) => {
      if (generation !== this.wsGeneration) return;
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

  async healthCheck(): Promise<Record<string, unknown>> {
    const health = await request("/health");
    if (!health["ok"]) throw new Error("unhealthy");
    numCtx = Number(health["numCtx"] ?? 16384);
    return health;
  }

  private printDashboard(): void {
    const ctx = meter(this.ctxPct);
    const tps = this.tokensPerSec !== null ? C.gold + this.tokensPerSec.toFixed(1) + " tok/s" + C.reset + "  " : "";
    const tool = this.lastTool
      ? C.dim + "last " + C.reset + this.lastTool + (this.lastToolMs ? C.dim + " " + fmtSecs(this.lastToolMs) + C.reset : "") + "  "
      : "";
    const dashboard =
      "● " + this.stateLabel + " · steps " + this.steps + " · ctx " + this.ctxPct + "%" +
      (this.tokensPerSec !== null ? " · " + this.tokensPerSec.toFixed(1) + " tok/s" : "") +
      (this.lastTool ? " · " + this.lastTool : "");
    if (this.ui) {
      this.ui.setStatus(this.stateLabel, this.steps);
    } else this.tty.write(fit(
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

  async onEvent(event: StreamEvent): Promise<void> {
    const p = event.payload;
    const uiMode = this.ui !== null;
    switch (event.type) {
      case "token.delta": {
        if (!this.streaming) {
          this.chipClose();
          this.streaming = true;
          this.stateLabel = "RESPONDING";
          if (uiMode) {
            this.ui!.streamStart();
            this.ui!.stream(C.gold + "✦ " + C.reset + C.cream + (p["text"] as string) + C.reset);
            break;
          } else {
            this.tty.write(C.gold + C.bold + "  ✦ " + brandName().toLowerCase() + " " + C.reset + C.dim + "─".repeat(Math.max(4, WIDTH() - 12)) + C.reset + "\n" + C.cream + "  ");
          }
        }
        if (uiMode) this.ui!.stream(p["text"] as string);
        else this.tty.write(p["text"] as string);
        break;
      }
      case "message.completed":
        if (this.streaming) {
          if (uiMode) this.ui!.streamEnd();
          else this.tty.write(C.reset + "\n");
          this.streaming = false;
        }
        break;
      case "tool.requested": {
        this.chipClose();
        if (this.streaming) this.streaming = false;
        this.toolStart = Date.now();
        const args = JSON.stringify(p["arguments"] ?? {});
        const short = args.length > WIDTH() - 30 ? args.slice(0, WIDTH() - 33) + "..." : args;
        const toolLine = "  " + C.teal + (TOOL_ICON[String(p.name)] ?? "◆") + C.reset + " " +
          C.bold + String(p.name) + C.reset + C.dim + " " + short + C.reset;
        if (uiMode) this.ui!.printAbove([toolLine]);
        else {
          this.tty.write(toolLine + " ");
          this.chipOpen = true;
        }
        break;
      }
      case "tool.result": {
        const ms = Date.now() - this.toolStart;
        this.lastTool = String(p["name"] ?? "");
        this.lastToolMs = ms;
        const ok = p["ok"] === true;
        if (uiMode) {
          this.ui!.replaceLast(
            "  " + C.teal + (TOOL_ICON[String(this.lastTool)] ?? "◆") + C.reset + " " +
            C.bold + this.lastTool + C.reset + "  " +
            (ok ? C.green + "✔ ok " + fmtSecs(ms) + C.reset : C.red + "✘ " + (p["error"] as string ?? "failed") + C.reset),
          );
        } else {
          this.tty.write(
            ok
              ? C.green + `  ✔ ok ${fmtSecs(ms)}` + C.reset
              : C.red + `  ✘ ${fmtSecs(ms)} ` + (p["error"] as string ?? "failed") + C.reset,
          );
          this.tty.write("\n");
          this.chipOpen = false;
        }
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
        if (uiMode) {
          this.ui!.printAbove([p["ok"] === true
            ? C.green + "✔ verified " + C.reset + C.dim + (p["command"] as string) + C.reset
            : C.red + "✘ verify FAILED " + C.reset + C.dim + (p["command"] as string) + C.reset]);
        } else {
          this.tty.write(
            p["ok"] === true
              ? C.green + "  ✔ verified" + C.reset + C.dim + "  " + p["command"] + C.reset + "\n"
              : C.red + "  ✘ verify FAILED" + C.reset + C.dim + "  " + p["command"] + C.reset + "\n",
          );
        }
        break;
      case "turn.completed":
        this.steps = Number(p["steps"] ?? 0);
        this.chipClose();
        this.stateLabel = "DONE";
        this.printDashboard();
        break;
      case "turn.failed":
        this.chipClose();
        this.lastFailure = String(p["reason"] ?? "");
        this.failureShown = false;
        if (!this.awaitingRun) {
          this.onError("failed: " + (p["reason"] ?? ""));
          this.failureShown = true;
        }
        break;
      case "turn.aborted":
        this.chipClose();
        this.onError("aborted");
        break;
      case "context.compacted":
        if (uiMode) this.ui!.printAbove([C.dim + "· context compacted ·" + C.reset]);
        else this.tty.write(C.dim + "  · context compacted ·\n" + C.reset);
        break;
      default:
        break;
    }
  }

  private async handlePermission(p: Record<string, unknown>): Promise<void> {
    this.chipClose();
    if (this.streaming) this.streaming = false;
    const uiMode = this.ui !== null;
    if (uiMode) {
      this.ui!.printAbove([C.gold + "⛨ permission" + C.reset + " " + (p["target"] as string)]);
    } else {
      this.tty.write("\n" + C.inverse + C.gold + C.bold + " ⛨ PERMISSION " + C.reset + C.dim + " " + (p["class"] as string) + C.reset + "\n");
      this.tty.write(C.bold + "  " + (p["target"] as string) + C.reset + "\n");
    }
    const preview = p["preview"] as string | undefined;
    if (preview) {
      const box = WIDTH() - 6;
      for (const line of wrap(preview, box).slice(0, 16)) {
        const colored = line.startsWith("+") ? C.green + line : line.startsWith("-") ? C.red + line : C.dim + line;
        if (this.ui) this.ui.printAbove(["  " + colored]);
        else this.tty.write("  " + colored + C.reset + "\n");
      }
    }
    const target = p["target"] as string;
    let approved = false;
    if (this.isAllowed(target)) {
      approved = true;
      if (this.ui) this.ui.printAbove([C.dim + "  (allowed earlier this session)" + C.reset]);
      else this.tty.write(C.dim + "  (allowed earlier this session)\n" + C.reset);
    } else {
      const answer = await this.permissionAsk();
      approved = answer !== "n";
      if (answer === "v") this.allows.add(target);
    }
    await request("/agent/permissions", {
      requestId: String(p["requestId"] ?? ""),
      approved,
      sessionId: this.sessionId,
      ...(typeof p["taskId"] === "string" && p["taskId"] ? { taskId: p["taskId"] } : {}),
    });
    if (this.ui) this.ui.printAbove([C.dim + (approved ? "· allowed ·" : "· denied ·") + C.reset]);
    else this.tty.write(C.dim + (approved ? "  · allowed ·\n" : "  · denied ·\n") + C.reset);
  }

  private isAllowed(target: string): boolean {
    for (const a of this.allows) {
      if (target === a || target.startsWith(a + " ")) return true;
    }
    return false;
  }

  private line(text: string): void {
    if (this.ui) this.ui.printAbove([text]);
    else this.tty.write(text + "\n");
  }

  private stream(text: string): void {
    if (this.ui) this.ui.stream(text);
    else this.tty.write(text);
  }

  async run(task: string, images: LoadedImage[] = []): Promise<void> {
    this.lastTool = "";
    this.awaitingRun = true;
    try {
      await this.runOnce(task, images);
    } finally {
      this.awaitingRun = false;
    }
  }

  private async runOnce(task: string, images: LoadedImage[]): Promise<void> {
    this.lastTool = "";
    if (this.ui) {
      const tag = images.length > 0 ? C.dim + "  +" + images.length + " img" + C.reset : "";
      this.ui.printAbove([C.inverse + C.bold + " YOU " + C.reset + " " + task + tag]);
    }
    const tag = images.length > 0 ? C.dim + "  +" + images.length + " image" + (images.length > 1 ? "s" : "") + C.reset : "";
    if (!this.ui) this.tty.write(C.inverse + C.bold + " YOU " + C.reset + " " + task + tag + "\n");
    const payload: Record<string, unknown> = { sessionId: this.sessionId, task, role: this.role };
    if (images.length > 0) payload["images"] = images.map((image) => toDataUrl(image.mime, image.base64));
    const result = await request("/agent/run", payload);
    if (!result["ok"]) {
      const message = String(result["error"] ?? "unknown");
      if (!message.includes("aborted") && (message !== this.lastFailure || !this.failureShown)) {
        this.onError(message);
      }
      this.lastFailure = "";
      this.failureShown = false;
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
