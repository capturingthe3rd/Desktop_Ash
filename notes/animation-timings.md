# Animation Timings

Chosen values for Phase 1. Adjust based on visual feel during testing.
Source of truth is `src/renderer/animation-rows.ts`.

## Idle (row 0, 6 frames)
- Per frame: **250ms** — slow, contemplative. Ash breathes and blinks.
- Last frame: **600ms** — long hold on the "end of thought" pose before looping.
- Play count: infinite loop.

## Action states (rows 1-8)
- Per frame: **80ms** — fast and punchy. Matches Codex's snappy feel.
- Last frame: **250ms** — brief settle beat so transitions don't feel cut off.
- Play count: **3 loops** then fall to idle.

## Per-state TTLs (from state-queue.ts)
| State | TTL |
|---|---|
| idle | None (sticky) |
| waving | 1500ms |
| jumping | 1500ms |
| failed | 2500ms |
| running | 3000ms |
| running-left | 3000ms |
| running-right | 3000ms |
| review | 3000ms |
| waiting | 3000ms |

## Rationale
- 80ms/frame at 8 frames = ~640ms/loop. Three loops = ~1.9s animation before idle decay.
- Most TTLs are set longer than 3 loops so the animation finishes naturally before TTL fires.
- `waving` and `jumping` (1500ms) are short — they're greeting/celebration beats, not prolonged states.
- `failed` (2500ms) gets extra beat time — it should feel like a real reaction, not a blip.
- Idle's 250ms/600ms rhythm gives a "thinking and waiting" feel vs a twitchy loop.

## Tuning notes (update after visual test)
- If idle feels too fast, bump frameMs to 300ms.
- If action states feel laggy, drop frameMs to 60ms.
- If the last-frame hold feels too long, drop lastFrameMs on action states to 150ms.
