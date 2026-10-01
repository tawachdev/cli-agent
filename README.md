# cli-agent

A terminal AI coding agent in one package. Clone, install, run — the terminal is the whole product: no web app, no dashboard, no accounts, no telemetry.

- **Terminal UI** — pixel-art boot screen, boxed prompt, model picker, permission cards with visible diffs; repaints cleanly on any terminal size.
- **Any model, your keys** — first launch walks you through picking a provider (anthropic, openai, deepseek, glm, gemini) and pasting an API key; keys live in the macOS Keychain, never logged, never returned.
- **Make it yours** — the product name and its two colors are one environment variable away, or one line for a permanent rebrand.
- **Images in the terminal** — drop an image path into the prompt: real pixels on iTerm2/WezTerm/kitty/Ghostty, a clean info panel elsewhere; the model sees it either way.

Live demo: **https://mimon-landing.vercel.app**

## Install — one command, nothing else

With npm (or pnpm/yarn/bun — any of them):

```sh
npm i -g mimon
mimon
```

No clone, no build step: the package carries a self-contained binary for your platform (macOS/Linux, arm64/x64 — the runtime is embedded). First launch opens the setup wizard in the terminal: pick a provider (anthropic, openai, deepseek, glm, gemini, or any OpenAI-compatible endpoint), paste its API key — the key is tested live and every tier routes to it. Your keys stay on your machine (macOS Keychain; a 0600 file elsewhere). One-shot without installing: `npx mimon-cli "summarize this folder"`.

Prefer curl? Same binary from GitHub Releases:

```sh
curl -fsSL https://raw.githubusercontent.com/tawachdev/cli-agent/main/install.sh | sh
agent
```

Downloads a single self-contained binary (macOS/Linux, arm64/x64 — the runtime is embedded, nothing to install), verifies its checksum, puts it on your PATH. First launch opens the setup wizard in the terminal: bring any API key (anthropic, openai, deepseek, glm, gemini, or any OpenAI-compatible endpoint).

From source instead (development):

```sh
bun install
bun run cli
```

The wizard asks for your API key — nothing else is required. If a tier is ever bound to a provider without a key, the boot notice tells you exactly which one to fix.

The CLI starts the local engine by itself (loopback-only, port `7800`). Interactive TUI: `bun run cli`. Engine alone: `bun run dev`.

The terminal is the whole product and the `/` menu is its control panel: `/setup` connects a provider (pick one, paste the key, it is tested live and bound to all four tiers), `/brand` changes the name and colors, `/model` routes tiers. A quiet hint appears on first launch if no provider is connected — nothing takes over your screen.

## Make it yours

Any OpenAI-compatible endpoint (Groq, OpenRouter, Together, LM Studio...) is a first-class citizen: `/providers` → **+ add provider** → name, base URL, models — it joins the list like a builtin; open it to set its key and bind a tier. Custom providers persist in `.agent/providers.json` (`kind` is always `openai`; other kinds can be added by editing that file). Base URLs are validated defensively before the engine ever dials one: real URL parse, public `https://` only (`http` allowed for 127.0.0.1/localhost), private and link-local IP ranges (10.x, 192.168.x, 172.16–31.x, 169.254.x), embedded credentials, control characters and overlong values are all rejected.

Inside the TUI: type `/` and pick **/brand** — change the name (2–12 letters), change colors (one for the whole name or one per letter, from presets, the 256-color grid, or custom hex — applied colors are remembered as your swatches), or reset. The choice is saved (`.agent/brand.json`) and every launch after that boots with your brand — no environment variables needed.

Environment works too:

```sh
AGENT_NAME=ANIR AGENT_COLORS=purple,gold bun run cli
```

`AGENT_NAME` — 2–12 letters, spells your name in the pixel font (full A–Z, two sizes). `AGENT_COLORS` — one color **per letter**, cycled if shorter: `AGENT_COLORS=green,black,red,blue` paints M in green, I in black… The picker in `/brand` offers two modes: **one color for the whole name**, or **a color for each letter** — walked letter by letter with a live preview of your name. Palette: **all 256 terminal colors** as a browsable grid (arrows to move, enter to pick), 14 quick presets, or any color you want via **custom hex…** (`#rrggbb`, rendered as truecolor where the terminal supports it). Colors you apply are remembered: your custom hex swatches join the palette for every next time (up to 12, kept in `.agent/brand.json`). Invalid values fall back to the defaults. Permanent defaults live in `src/shared/brand.ts` (`DEFAULT_BRAND` / `DEFAULT_COLORS`) — one file owns the identity. A saved `/brand` choice wins over the environment.

Technical identifiers (`AGENT_*` env vars, `.agent/` state folder, `agent` Keychain service, port `7800`) are stable on purpose so the product can coexist with any other agent on the same machine.

## Images in the terminal

Drag an image into the terminal: the path disappears, the image renders immediately as a preview, and a `▤N` counter appears in the status bar — enter sends it with your message (esc clears the attachments). You can also just type a path:

```sh
bun run cli "what does /path/to/screenshot.png show?"
```

Up to 4 images per message, 6 MB each (png, jpeg, gif, webp, bmp), validated by magic bytes end to end. Images need a vision-capable model on the active tier (a cloud vision model on the active tier); models without tool support are handled automatically by the engine.

## CLI keys

| Key | Action |
|-----|--------|
| `enter` | send · `/` command menu · `tab` cycle model tier |
| `/setup` `/providers` `/model` | wizard · keys & custom providers · tier routing |
| `esc` | stop a turn / close a menu · `ctrl+c` quit |

## Configuration

| Variable | Default | Notes |
|----------|---------|-------|
| `AGENT_PORT` | `7800` | engine, loopback only |
| `AGENT_NAME` / `AGENT_COLORS` | `MIMON` / `teal,gold` | display identity |
| `AGENT_MODEL_TIER1..MAX` | unset | tier routing, `.agent/models.json` wins over env |
| `AGENT_KEY_<PROVIDER>` | — | key per provider (Keychain is the primary store) |
| `AGENT_WORKSPACE_ROOT` | engine cwd | the only directory file tools may touch |

## Verify

```sh
bun run typecheck        tsc --noEmit, strict
bun test                 TUI resize storms, pixel font, image pipeline, engine routes
bun run stage            renders every TUI state (works with AGENT_NAME / AGENT_COLORS)
```

## Safety

Read-only tools auto-run; write and exec ask first with a visible diff. Engine binds `127.0.0.1` only; the CLI refuses non-loopback engines. Every tool call and permission decision lands in an append-only audit log. Keys stay in the macOS Keychain (or `AGENT_KEY_*` env), never logged, never audited, never returned by any endpoint.
