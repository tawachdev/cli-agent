# Changelog

What changed in each release, newest first. Add a line under **Unreleased**
with every user-visible change; `bun run release` moves it under the new version.

## Unreleased

### Images
- Pasted or dropped images wait in the composer above the prompt, so you can say what the model should do with them; Enter sends them together and they move under your message in the transcript.
- kitty and Ghostty show the whole image (it was cropped to a sliver), iTerm2 and WezTerm draw it inside the box at every width, and every other terminal (Terminal.app, VS Code, tmux) shows a color thumbnail instead of opening an external viewer.
- ⌫ on an empty prompt removes the last image, esc removes them all, ctrl+o opens them in the system viewer.

### Reliability
- Stopping or timing out a command now stops everything it started; a stuck child no longer hangs the turn.
- A corrupted `keys.json`, `models.json` or `brand.json` is set aside instead of being overwritten — saving one key can no longer erase the others. All three are written atomically.
- Tool calls whose arguments arrive as broken JSON are reported to the model instead of running with empty arguments.
- An error shown while an answer is streaming no longer has the next streamed words glued onto it.

### Engineering
- Lint (Biome) runs in CI; `bun run check` runs typecheck, lint and tests.
- The TUI is split into focused modules; `tui.ts` went from 2,198 to 1,030 lines.
- A pinned golden session catches any change to what the TUI draws or does; end-to-end tests drive the real CLI in a pseudo-terminal as iTerm2, kitty and a plain terminal, and through a resize storm.
- `bun run release` bumps all twelve version sites, cuts this changelog, runs the gate, commits and tags.

## 0.1.18 — 2026-10-11

- Retry engine boot once so reopening right after a close recovers.
- Show pasted images as compact thumbnails instead of half-screen renders.
