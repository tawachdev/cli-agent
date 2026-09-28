# cli-agent

A terminal AI coding agent in one package. Clone, install, run — the terminal is the whole product: no web app, no dashboard, no accounts, no telemetry.

- **Terminal UI** — pixel-art boot screen, boxed prompt, model picker, permission cards with visible diffs; repaints cleanly on any terminal size.
- **Any model, your keys** — first launch walks you through picking a provider (anthropic, openai, deepseek, glm, gemini) and pasting an API key; keys live in the macOS Keychain, never logged, never returned. Local Ollama works with zero keys.
- **Make it yours** — the product name and its two colors are one environment variable away, or one line for a permanent rebrand.
- **Images in the terminal** — drop an image path into the prompt: real pixels on iTerm2/WezTerm/kitty/Ghostty, a clean info panel elsewhere; the model sees it either way.

## 30-second start

```sh
bun install
ollama serve & ollama pull qwen2.5-coder:14b
bun run cli "read README.md and summarize it in one line"
```

The CLI starts the local engine by itself (loopback-only, port `7800`). Interactive TUI: `bun run cli`. Engine alone: `bun run dev`.

The terminal is the whole product and the `/` menu is its control panel: `/setup` connects a provider (pick one, paste the key, it is tested live and bound to all four tiers), `/brand` changes the name and colors, `/model` routes tiers. A quiet hint appears on first launch if no provider is connected — nothing takes over your screen.

## Make it yours

Inside the TUI: type `/` and pick **/brand** — change the name (2–12 letters), pick two colors live from the palette, or reset. The choice is saved (`.agent/brand.json`) and every launch after that boots with your brand — no environment variables needed.

Environment works too:

```sh
AGENT_NAME=ANIR AGENT_COLORS=purple,gold bun run cli
```

`AGENT_NAME` — 2–12 letters, spells your name in the pixel font (full A–Z, two sizes). `AGENT_COLORS` — two names from the palette: `teal gold cream green red slate purple blue cyan orange pink white gray dark`. Invalid values fall back to the defaults. Permanent defaults live in `src/shared/brand.ts` (`DEFAULT_BRAND` / `DEFAULT_COLORS`) — one file owns the identity. A saved `/brand` choice wins over the environment.

Technical identifiers (`AGENT_*` env vars, `.agent/` state folder, `agent` Keychain service, port `7800`) are stable on purpose so the product can coexist with any other agent on the same machine.

## Images in the terminal

```sh
bun run cli "what does /path/to/screenshot.png show?"
```

Up to 4 images per message, 6 MB each (png, jpeg, gif, webp, bmp), validated by magic bytes end to end. Images need a vision-capable model on the active tier (`AGENT_MODEL_TIER2=qwen2.5vl:7b` or a cloud vision model); models without tool support are handled automatically by the engine.

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
| `AGENT_MODEL_TIER1..MAX` | qwen3 / qwen2.5-coder | tier routing, `.agent/models.json` wins over env |
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
