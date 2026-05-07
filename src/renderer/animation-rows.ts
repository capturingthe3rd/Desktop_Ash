import type { PetState } from "../shared/types.js";

export interface AnimationRow {
  row: number;
  frames: number;
  // ms per frame for all but the last frame
  frameMs: number;
  // ms for the last frame (hold/settle beat)
  lastFrameMs: number;
  // how many times to play the full row before transitioning to idle
  // null = loop indefinitely (idle behaviour)
  playCount: number | null;
}

// Timing tuned for Codex-feel.
// Idle is slow and contemplative; reaction states are snappy with a settle beat.
// Locomotion states (running, running-left, running-right) loop indefinitely so
// the sprite keeps animating for as long as the queue says they're active —
// otherwise wander mode glides silently after the 3× cycle ends.
// v3 states follow the same pattern: 3× play then idle, except sleeping and
// sitting which loop indefinitely (state is held, not a one-shot reaction).
// See notes/animation-timings.md for rationale.
export const ANIMATION_ROWS: Record<PetState, AnimationRow> = {
  // --- rows 0-8: original vocabulary ---
  idle:                { row: 0,  frames: 6, frameMs: 250, lastFrameMs: 600,  playCount: null },
  "running-right":     { row: 1,  frames: 8, frameMs: 80,  lastFrameMs: 80,   playCount: null },
  "running-left":      { row: 2,  frames: 8, frameMs: 80,  lastFrameMs: 80,   playCount: null },
  waving:              { row: 3,  frames: 4, frameMs: 80,  lastFrameMs: 250,  playCount: 3 },
  jumping:             { row: 4,  frames: 5, frameMs: 80,  lastFrameMs: 250,  playCount: 3 },
  failed:              { row: 5,  frames: 8, frameMs: 80,  lastFrameMs: 250,  playCount: 3 },
  waiting:             { row: 6,  frames: 6, frameMs: 80,  lastFrameMs: 250,  playCount: 3 },
  running:             { row: 7,  frames: 6, frameMs: 80,  lastFrameMs: 80,   playCount: null },
  review:              { row: 8,  frames: 6, frameMs: 80,  lastFrameMs: 250,  playCount: 3 },
  // --- rows 9-25: v3 extension vocabulary (ash-deluxe-v3) ---
  thinking:            { row: 9,  frames: 5, frameMs: 80,  lastFrameMs: 250,  playCount: 3 },
  sitting:             { row: 10, frames: 4, frameMs: 100, lastFrameMs: 600,  playCount: null }, // held state, loops indefinitely
  "looking-around":    { row: 11, frames: 6, frameMs: 80,  lastFrameMs: 250,  playCount: 3 },
  "happy-sit":         { row: 12, frames: 4, frameMs: 80,  lastFrameMs: 250,  playCount: 3 },
  stretching:          { row: 13, frames: 5, frameMs: 80,  lastFrameMs: 250,  playCount: 3 },
  sleeping:            { row: 14, frames: 3, frameMs: 100, lastFrameMs: 600,  playCount: null }, // held state, loops indefinitely
  yawning:             { row: 15, frames: 4, frameMs: 80,  lastFrameMs: 250,  playCount: 3 },
  "scratching-ear":    { row: 16, frames: 5, frameMs: 80,  lastFrameMs: 250,  playCount: 3 },
  "sniffing-ground":   { row: 17, frames: 4, frameMs: 80,  lastFrameMs: 250,  playCount: 3 },
  "head-tilt-curious": { row: 18, frames: 4, frameMs: 80,  lastFrameMs: 250,  playCount: 3 },
  "begging-paws-up":   { row: 19, frames: 4, frameMs: 80,  lastFrameMs: 250,  playCount: 3 },
  "bouncing-excited":  { row: 20, frames: 4, frameMs: 80,  lastFrameMs: 250,  playCount: 3 },
  "spinning-circle":   { row: 21, frames: 4, frameMs: 80,  lastFrameMs: 250,  playCount: 3 },
  "rolling-belly-up":  { row: 22, frames: 5, frameMs: 80,  lastFrameMs: 250,  playCount: 3 },
  howling:             { row: 23, frames: 3, frameMs: 80,  lastFrameMs: 250,  playCount: 3 },
  "listening-alert":   { row: 24, frames: 3, frameMs: 80,  lastFrameMs: 250,  playCount: 3 },
  "reading-thinking":  { row: 25, frames: 8, frameMs: 80,  lastFrameMs: 250,  playCount: 3 }, // 8 frames confirmed by spritesheet inspection
};
