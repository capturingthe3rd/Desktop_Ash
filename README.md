# Desktop Ash

A standalone Electron overlay that puts an animated pixel pet on your desktop, driven by simple HTTP pushes from any tool that can run `curl`.

Pair it with Claude Code, Codex, or any agent that runs locally — your pet reacts when the agent works, errors, completes, or waits.

## Features

- **9 states**: idle, running, running-left, running-right, waving, jumping, failed, waiting, review
- **HTTP-driven**: `POST http://127.0.0.1:7878/state` from anything (curl, Claude Code hooks, custom scripts)
- **Per-display scale memory**: drag the pet between monitors, each display remembers its own size
- **Keyboard shortcuts**: `Cmd+=` / `Cmd+-` / `Cmd+0` to resize on the fly
- **Codex bridge** (opt-in): tails Codex Desktop session JSONL files and translates events into states automatically
- **Frameless transparent always-on-top** window across all macOS Spaces and full-screen apps
- **Singleton-locked**: only one Ash at a time
- **Read-only of your pet assets**: never modifies anything in `~/.codex/pets/`

## Prerequisites

You need at least one pet at `~/.codex/pets/<id>/` containing:
- `pet.json` with fields `id`, `displayName`, `description`, `spritesheetPath`
- A spritesheet PNG/WebP at the path declared in `spritesheetPath`

**If you have [Codex Desktop](https://chatgpt.com/codex) installed and have hatched pets**, this is already populated.

**If not**, you can drop in your own. Spritesheet must be a 1536×1872 PNG (8 columns × 9 rows of 192×208 cells, one row per state). See `notes/animation-timings.md` for the row layout.

## Quick Start

```bash
npm install
npm start
```

First launch opens a pet picker. Select your pet once — the choice persists at `~/Library/Application Support/Desktop_Ash/config.json`. Subsequent launches go straight to the overlay.

> If launching from a terminal that sets `ELECTRON_RUN_AS_NODE=1` (e.g. Claude Code), use `npm start` — the script clears that env var automatically.

## HTTP API

Server binds to `127.0.0.1:7878` (localhost only — never exposed externally).

### Push a state

```bash
curl -X POST http://127.0.0.1:7878/state \
  -H 'content-type: application/json' \
  -d '{"state": "running", "agent": "my-tool", "ttlMs": 3000, "priority": 0}'
```

Valid states: `idle`, `running`, `running-left`, `running-right`, `waving`, `jumping`, `failed`, `waiting`, `review`.

Optional fields:
- `ttlMs` — milliseconds before decaying back to idle. Defaults vary per state (see below).
- `agent` — string label for logging. Useful when multiple tools drive the pet.
- `priority` — higher value wins when a previous state is still active. Default 0. On tie, latest push wins.

### Get current state

```bash
curl http://127.0.0.1:7878/state
```

### Default TTLs

| State | TTL |
|---|---|
| idle | sticky (no expiry) |
| waving, jumping | 1500ms |
| failed | 2500ms |
| running, running-left, running-right, review, waiting | 3000ms |

## Smoke Test

With the app running, in another terminal:

```bash
bash scripts/smoke.sh
```

Cycles all 9 states with GET checks between pushes.

## Window Controls

When the overlay window is focused:

| Shortcut | Action |
|---|---|
| `Cmd+=` | Grow by 0.25× |
| `Cmd+-` | Shrink by 0.25× |
| `Cmd+0` | Reset to 1.5× default |

Each adjustment auto-saves for the current display. Drag the pet between monitors and it resizes to that display's saved scale automatically. Range: 0.5× to 5×.

## Driving Ash from Claude Code

Add hooks to `~/.claude/settings.json` (the four `SessionStart`, `PreToolUse`, `PostToolUse`, `Stop` events) pointing at a small bash script that POSTs to `:7878`. Hook script must be fire-and-forget (`curl --max-time 0.5 &` and exit 0) so it never blocks Claude Code.

State mapping suggestion:

| Hook | Tool category | State |
|---|---|---|
| SessionStart | — | waving |
| PreToolUse | Read / Grep / Glob / LS | review |
| PreToolUse | Bash / Edit / Write | running |
| PostToolUse | error result | failed |
| Stop | — | jumping |

**A ready-to-use hook script lives at [`scripts/claude-hooks/desktop_ash.sh`](scripts/claude-hooks/desktop_ash.sh).** To install:

```bash
cp scripts/claude-hooks/desktop_ash.sh ~/.claude/hooks/desktop_ash.sh
chmod +x ~/.claude/hooks/desktop_ash.sh
```

Then add hook entries in `~/.claude/settings.json`:

```json
{
  "hooks": {
    "SessionStart":     [{"matcher": "", "hooks": [{"type": "command", "command": "/Users/YOU/.claude/hooks/desktop_ash.sh"}]}],
    "UserPromptSubmit": [{"matcher": "", "hooks": [{"type": "command", "command": "/Users/YOU/.claude/hooks/desktop_ash.sh"}]}],
    "PreToolUse":       [{"matcher": "", "hooks": [{"type": "command", "command": "/Users/YOU/.claude/hooks/desktop_ash.sh"}]}],
    "PostToolUse":      [{"matcher": "", "hooks": [{"type": "command", "command": "/Users/YOU/.claude/hooks/desktop_ash.sh"}]}],
    "Stop":             [{"matcher": "", "hooks": [{"type": "command", "command": "/Users/YOU/.claude/hooks/desktop_ash.sh"}]}],
    "SubagentStop":     [{"matcher": "", "hooks": [{"type": "command", "command": "/Users/YOU/.claude/hooks/desktop_ash.sh"}]}]
  }
}
```

The script throttles rapid PreToolUse / UserPromptSubmit events at 1500ms intervals so Ash doesn't flicker. Stop and PostToolUse-error always fire (no throttle).

## Driving Ash from Codex Desktop (opt-in)

Edit `~/Library/Application Support/Desktop_Ash/config.json`:

```json
{
  "selectedPetId": "ash-deluxe",
  "codexBridgeEnabled": true
}
```

Restart the app. The Codex bridge tails the latest session JSONL at `~/.codex/sessions/<year>/<date>/*.jsonl` and translates events:

| Codex event | State |
|---|---|
| `session_meta` | waving |
| `event_msg / task_started` | waiting |
| `response_item / function_call` | running |
| `event_msg / exec_command_end` | running |
| `function_call_output` (non-zero exit) | failed |
| `event_msg / task_complete` | jumping |
| `event_msg / error` | failed |

Codex's own pet overlay (if you have one) keeps running side-by-side. This bridge does not modify Codex.

See [`notes/codex-event-schema.md`](notes/) and [`notes/codex-event-samples.md`](notes/codex-event-samples.md) for the full schema reference.

## Architecture

```
src/
  main/
    main.ts          — Electron app lifecycle, window creation, singleton lock,
                       per-display scale memory, keyboard shortcuts
    server.ts        — node:http on 127.0.0.1:7878 (POST/GET /state)
    state-queue.ts   — priority queue + TTL decay back to idle
    ipc.ts           — main ↔ renderer IPC bridge
    config.ts        — persists app config to ~/Library/Application Support/Desktop_Ash/
    pet-scanner.ts   — reads ~/.codex/pets/*/pet.json (read-only)
  renderer/
    preload.ts       — contextBridge exposing window.ash API
    renderer.ts      — spritesheet animator (single div, background-position math)
    animation-rows.ts — row/state/timing table
    picker.ts        — first-run pet selection UI
    index.html       — overlay window
    picker.html      — picker window
  codex-bridge/
    watcher.ts       — chokidar tail of latest Codex session JSONL
    event-mapper.ts  — Codex events → state pushes
    index.ts         — start/stop lifecycle
  shared/
    types.ts         — wire format + config types
```

## Build & Distribute

```bash
npm run build           # tsc main process + vite renderer
npx electron-builder    # produce a .dmg for distribution (uses electron-builder.yml)
```

Change `appId` in `package.json` and `electron-builder.yml` to your own reverse-DNS namespace before distributing.

## License

MIT — see [LICENSE](LICENSE).
