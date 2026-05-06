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
// Idle is slow and contemplative; action states are snappy with a settle beat.
// See notes/animation-timings.md for rationale.
export const ANIMATION_ROWS: Record<PetState, AnimationRow> = {
  idle:           { row: 0, frames: 6, frameMs: 250, lastFrameMs: 600,  playCount: null },
  "running-right":{ row: 1, frames: 8, frameMs: 80,  lastFrameMs: 250,  playCount: 3 },
  "running-left": { row: 2, frames: 8, frameMs: 80,  lastFrameMs: 250,  playCount: 3 },
  waving:         { row: 3, frames: 4, frameMs: 80,  lastFrameMs: 250,  playCount: 3 },
  jumping:        { row: 4, frames: 5, frameMs: 80,  lastFrameMs: 250,  playCount: 3 },
  failed:         { row: 5, frames: 8, frameMs: 80,  lastFrameMs: 250,  playCount: 3 },
  waiting:        { row: 6, frames: 6, frameMs: 80,  lastFrameMs: 250,  playCount: 3 },
  running:        { row: 7, frames: 6, frameMs: 80,  lastFrameMs: 250,  playCount: 3 },
  review:         { row: 8, frames: 6, frameMs: 80,  lastFrameMs: 250,  playCount: 3 },
};
