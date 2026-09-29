import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { exit, stdin, stdout } from "node:process";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { brandName } from "../src/shared/brand";
import { C, decodeChunk, PRODUCT_VERSION, splash, Tui, type Tty } from "../src/tui/tui";
import {
  addProvider,
  backendOrigin,
  keylessProviderBindings,
  Chat,
  deleteProviderKey,
  getBindings,
  getBrand,
  getProviders,
  getSetupStatus,
  putBinding,
  putBrand,
  putProviderKey,
  testProvider,
} from "../src/tui/chat";
import { loadImages } from "../src/tui/images";

const tty: Tty = {
  write: (data) => stdout.write(data),
  get columns() {
    return stdout.columns ?? 80;
  },
  get rows() {
    return stdout.rows ?? 24;
  },
};

let keyBuffer = "";

function feedKeys(chunk: string, tui: Tui): void {
  const { keys, rest } = decodeChunk(keyBuffer + chunk);
  keyBuffer = rest;
  for (const key of keys) tui.handleKey(key);
}

async function main(): Promise<void> {
  if (process.argv[2] === "serve") {
    await import("../src/engine/app/bootstrap.ts");
    return;
  }
  const task = process.argv.slice(2).filter((arg) => arg !== "serve").join(" ").trim();
  const interactive = task === "";

  if (interactive && !stdin.isTTY) {
    stdout.write(C.red + "\n  interactive mode needs a terminal - pass a task instead:\n  bun run cli \"your task\"\n\n" + C.reset);
    exit(1);
  }

  const chat = new Chat(tty, async () => "n");
  let ui: Tui | null = null;
  let cleanup: () => void = () => {};
  let spawnedBackend: ChildProcess | null = null;
  let taskFailed = false;

  const bye = (): void => {
    stdout.write("\x1b[?1049l");
    cleanup();
    chat.close();
    spawnedBackend?.kill();
    stdout.write(C.reset + "\n" + C.gold + C.bold + "  ✦ take care\n\n" + C.reset);
    exit(0);
  };

  if (interactive) {
    stdout.write("\x1b[?1049h");
    stdin.setRawMode(true);
    stdin.resume();
    const handleTurn = async (t: string): Promise<void> => {
      try {
        const attached = tui.takePendingImages();
        const { images: fromText, errors } = await loadImages(t);
        const images = [...attached, ...fromText.filter((image) => !attached.some((a) => a.path === image.path))];
        for (const message of errors) stdout.write(C.dim + "  · " + message + C.reset + "\n");
        await chat.run(t, images);
        if (ui) ui.setRuntime(chat.ctxPct, chat.sessionId);
      } catch (error) {
        chat.onError(error instanceof Error ? error.message : "turn failed");
      } finally {
        ui?.endBusy();
      }
    };
    const handleCommand = async (name: string): Promise<void> => {
      if (!ui) return;
      switch (name) {
        case "/new":
          try {
            await chat.newSession();
            await chat.connect();
            chat.ctxPct = 0;
            ui.setRuntime(chat.ctxPct, chat.sessionId);
            ui.notice("✓ new session " + chat.sessionId.slice(0, 8));
          } catch (error) {
            ui.notice("✘ " + (error instanceof Error ? error.message : "session failed"));
          }
          return;
        case "/model":
          try {
            const roles = await getBindings();
            const map: Record<string, string> = {};
            for (const role of roles) map[role.role] = role.model;
            ui.openPicker(map);
          } catch {
            ui.openPicker();
          }
          return;
        case "/providers":
          try {
            ui.openProviders(await getProviders());
          } catch (error) {
            ui.notice("✘ " + (error instanceof Error ? error.message : "providers failed"));
          }
          return;
        case "/setup":
          try {
            ui.openWizard(await getProviders());
          } catch (error) {
            ui.notice("✘ " + (error instanceof Error ? error.message : "setup failed"));
          }
          return;
        case "/brand":
          try {
            ui.openBrand(await getBrand());
          } catch (error) {
            ui.notice("✘ " + (error instanceof Error ? error.message : "brand failed"));
          }
          return;
        case "/stop":
          await chat.abort();
          ui.notice("· abort sent ·");
          return;
        case "/help":
          ui?.showHelp([
            "enter send · / commands · tab cycle model",
            "esc stop turn / close menu · ctrl+c quit",
            "/new session · /model picker · /providers keys · /setup connect",
            "/brand name & colors · /stop abort",
          ]);
          return;
        case "/exit":
          bye();
          return;
        default:
          return;
      }
    };
    const refreshProviders = (): void => {
      if (!ui) return;
      getProviders()
        .then((list) => ui?.openProviders(list))
        .catch(() => {});
    };
    const applyBrand = (name: string, colors: string[]): void => {
      process.env.AGENT_NAME = name;
      process.env.AGENT_COLORS = colors.join(",");
      tui.refreshBrand();
    };
    const tui = new Tui(tty, {
      onSubmit: (t) => {
        void handleTurn(t);
      },
      onCommand: (name) => {
        void handleCommand(name);
      },
      onTierChange: (t) => {
        chat.role = t.id;
      },
      onAbort: () => {
        void chat.abort();
      },
      onExit: bye,
      onSetKey: (name, key) => {
        putProviderKey(name, key)
          .then(() => {
            ui?.notice("✓ key saved for " + name);
            refreshProviders();
          })
          .catch((error: Error) => ui?.notice("✘ " + error.message));
      },
      onRemoveKey: (name) => {
        deleteProviderKey(name)
          .then(() => {
            ui?.notice("✓ key removed from " + name);
            refreshProviders();
          })
          .catch((error: Error) => ui?.notice("✘ " + error.message));
      },
      onTestProvider: (name, model) => {
        ui?.notice("· testing " + name + "/" + model + "…");
        testProvider(name, model)
          .then((result) =>
            result["ok"] === true
              ? ui?.notice("✓ " + name + "/" + model + " answered")
              : ui?.notice("✘ " + String(result["error"] ?? "test failed")),
          )
          .catch((error: Error) => ui?.notice("✘ " + error.message));
      },
      onBindModel: (role, binding) => {
        putBinding(role, binding)
          .then((result) =>
            result["ok"] === true
              ? ui?.notice("✓ " + role + " → " + binding)
              : ui?.notice("✘ " + String(result["error"] ?? "bind failed")),
          )
          .catch((error: Error) => ui?.notice("✘ " + error.message));
      },
      onWizardKey: (name, key) => {
        void (async () => {
          try {
            await putProviderKey(name, key);
            const def = (await getProviders()).find((p) => p.name === name);
            const model = def?.models[0] ?? "";
            if (!model) throw new Error(name + " exposes no models to bind");
            ui?.notice("· testing " + name + "/" + model + "…");
            const result = await testProvider(name, model);
            if (result["ok"] !== true) {
              ui?.notice("✘ key saved but the test failed: " + String(result["error"] ?? "unknown") + " — recheck it in /providers");
              refreshProviders();
              return;
            }
            const binding = name + "/" + model;
            for (const role of ["mimon1", "mimon2", "mimon3", "mimonMax"]) await putBinding(role, binding);
            ui?.notice("✓ ready — " + binding + " now drives all " + brandName() + " tiers (change any time in /model)");
            refreshProviders();
          } catch (error) {
            ui?.notice("✘ " + (error instanceof Error ? error.message : "setup failed"));
            refreshProviders();
          }
        })();
      },
      onBrandName: (name) => {
        putBrand({ name })
          .then((result) => {
            if (result["ok"] !== true) throw new Error(String(result["error"] ?? "brand failed"));
            applyBrand(String(result["name"]), result["colors"] as string[]);
            ui?.setBrandCustomColors((result["customColors"] ?? []) as string[]);
            ui?.notice("✓ brand name set — " + String(result["name"]));
          })
          .catch((error: Error) => ui?.notice("✘ " + error.message));
      },
      onBrandColors: (colors) => {
        putBrand({ colors })
          .then((result) => {
            if (result["ok"] !== true) throw new Error(String(result["error"] ?? "brand failed"));
            applyBrand(String(result["name"]), result["colors"] as string[]);
            ui?.setBrandCustomColors((result["customColors"] ?? []) as string[]);
            ui?.notice("✓ colors set — " + colors.join(" + "));
          })
          .catch((error: Error) => ui?.notice("✘ " + error.message));
      },
      onBrandReset: () => {
        putBrand({ reset: true })
          .then((result) => {
            if (result["ok"] !== true) throw new Error(String(result["error"] ?? "brand failed"));
            applyBrand(String(result["name"]), result["colors"] as string[]);
            ui?.notice("· brand reset to defaults ·");
          })
          .catch((error: Error) => ui?.notice("✘ " + error.message));
      },
      onAddProvider: (name, baseUrl, models) => {
        addProvider({ name, kind: "openai", baseUrl, models })
          .then((result) => {
            if (result["ok"] !== true) throw new Error(String(result["error"] ?? "add failed"));
            ui?.notice("✓ " + name + " added — open it to set its key");
            refreshProviders();
          })
          .catch((error: Error) => {
            ui?.notice("✘ " + error.message);
            refreshProviders();
          });
      },
    });
    ui = tui;
    chat.permissionAsk = () => tui.permission();
    chat.uiHandlesErrors = true;
    chat.onError = (message) => tui.showError(message);
    chat.ui = {
      printAbove: (lines) => {
        for (const line of lines) tui.historyPush(line);
      },
      stream: (text) => tui.historyStream(text),
      streamStart: () => {},
      streamEnd: () => tui.historyStreamEnd(),
      replaceLast: (line) => tui.historyReplaceLast(line),
      setStatus: (state, steps) => tui.setChatStatus(state, steps),
    };
    stdin.on("data", (chunk) => feedKeys(String(chunk), tui));
    stdout.on("resize", () => tui.onResize());
    stdin.on("resize", () => tui.onResize());
    let seenCols = stdout.columns ?? 0;
    const widthWatch = setInterval(() => {
      const cols = stdout.columns ?? 0;
      if (cols !== seenCols) {
        seenCols = cols;
        tui.onResize();
      }
    }, 400);
    cleanup = () => {
      clearInterval(widthWatch);
      stdin.setRawMode(false);
      stdin.pause();
    };
  } else {
    const rl = createInterface({ input: stdin, output: stdout, terminal: stdout.isTTY === true });
    chat.onError = (message) => {
      taskFailed = true;
      stdout.write(C.red + "  ✘ " + message + "\n" + C.reset);
    };
    chat.permissionAsk = async () => {
      try {
        const answer = (await rl.question(C.gold + "  [a] once  [v] session  [n] deny › " + C.reset)).trim().toLowerCase();
        return answer === "a" || answer === "v" ? (answer as "a" | "v") : "n";
      } catch {
        stdout.write(C.dim + "\n  · no terminal input - permission denied ·\n" + C.reset);
        return "n";
      }
    };
    cleanup = () => rl.close();
  }

  try {
    await chat.healthCheck();
  } catch {

    const compiled = !process.execPath.endsWith("bun") && !process.execPath.includes("/bun-");
    const backendEnv = {
      ...process.env,
      AGENT_WORKSPACE_ROOT: process.cwd(),
      AGENT_DB_PATH: join(homedir(), ".agent", "agent.db"),
    };
    spawnedBackend = compiled
      ? spawn(process.execPath, ["serve"], { stdio: "ignore", env: backendEnv })
      : spawn(
          process.execPath,
          [fileURLToPath(new URL("../src/engine/app/bootstrap.ts", import.meta.url))],
          { stdio: "ignore", env: backendEnv, cwd: fileURLToPath(new URL("../src/engine", import.meta.url)) },
        );
    const killBackend = (): void => {
      spawnedBackend?.kill();
    };
    const die = (): void => {
      stdout.write("\x1b[?1049l");
      cleanup();
      killBackend();
      exit(0);
    };
    process.on("exit", killBackend);
    process.on("SIGINT", die);
    process.on("SIGTERM", die);
    process.on("SIGPIPE", die);
    let up = false;
    for (let i = 0; i < 30 && !up; i++) {
      await new Promise<void>((resolve) => setTimeout(resolve, 300));
      try {
        await chat.healthCheck();
        up = true;
      } catch {
        up = false;
      }
    }
    if (!up) {
      stdout.write("\x1b[?1049l");
      stdout.write(C.red + "\n  backend did not come up at " + backendOrigin + "\n  start it manually with: bun run dev\n\n" + C.reset);
      spawnedBackend?.kill();
      cleanup();
      exit(1);
    }

  }

  await chat.newSession();
  await chat.connect();
  if (ui) ui.setRuntime(chat.ctxPct, chat.sessionId);

  if (!interactive) {
    const { images, errors } = await loadImages(task);
    for (const message of errors) stdout.write(C.dim + "  · " + message + C.reset + "\n");
    splash(tty, PRODUCT_VERSION);
    await chat.run(task, images);
    chat.close();
    spawnedBackend?.kill();
    cleanup();
    exit(taskFailed ? 1 : 0);
  }

  let savedBrand: { name: string; colors: string[]; customColors: string[] } | null = null;
  try {
    savedBrand = await getBrand();
    process.env.AGENT_NAME = savedBrand.name;
    process.env.AGENT_COLORS = savedBrand.colors.join(",");
  } catch {
  }

  ui?.enableHero(PRODUCT_VERSION);
  ui?.show();
  if (savedBrand) ui?.setBrandCustomColors(savedBrand.customColors);
  void Promise.all([getSetupStatus(), getBindings(), getProviders()])
    .then(([status, roles, providers]) => {
      const stale = keylessProviderBindings(roles, providers);
      if (stale.length > 0) {
        const list = stale.map((s) => s.role + " → " + s.provider).join(", ");
        ui?.notice("⚠ bound without key: " + list + " — /providers → set key, or /model → rebind");
      } else if (status.needsSetup) {
        ui?.notice("· bring your API key — /setup connects it in seconds · /brand makes it yours ·");
      }
    })
    .catch(() => {});
  await new Promise<void>(() => {});
}

main().catch((error: Error) => {
  stdout.write(C.red + error.message + "\n" + C.reset);
  exit(1);
});
