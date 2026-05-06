// All 9 valid pet states — locked vocabulary, no additions without 2 real use cases
export type PetState =
  | "idle"
  | "running"
  | "running-left"
  | "running-right"
  | "waving"
  | "jumping"
  | "failed"
  | "waiting"
  | "review";

export const VALID_STATES: PetState[] = [
  "idle",
  "running",
  "running-left",
  "running-right",
  "waving",
  "jumping",
  "failed",
  "waiting",
  "review",
];

export function isValidState(s: string): s is PetState {
  return VALID_STATES.includes(s as PetState);
}

// Wire format for POST /state body
export interface StatePushRequest {
  state: PetState;
  ttlMs?: number;
  agent?: string;
  priority?: number;
  message?: string; // optional completion message; non-empty triggers speech bubble
}

// Wire format for GET /state response
export interface StateGetResponse {
  state: PetState;
  agent: string | null;
  until: string | null; // ISO timestamp, null when idle (no TTL)
  priority: number;
  message: string | null; // current entry's message, if any
}

// POST /state success response
export interface StatePushResponse {
  ok: true;
  current: PetState;
}

// Pet manifest — matches ~/.codex/pets/<id>/pet.json plus runtime-resolved fields
export interface PetManifest {
  id: string;
  displayName: string;
  description: string;
  spritesheetPath: string; // relative to pet dir (raw from JSON)
  spritesheetAbsolutePath: string; // resolved at scan time for renderer ash-asset:// URLs
}

// Stored config at ~/Library/Application Support/Desktop_Ash/config.json
export interface AppConfig {
  selectedPetId: string | null;
  // When true, the Codex bridge daemon starts with the app and tails session
  // JSONL files, translating Codex events into state pushes on :7878.
  // Opt-in: edit ~/Library/Application Support/Desktop_Ash/config.json and
  // set "codexBridgeEnabled": true, then restart Desktop Ash.
  codexBridgeEnabled?: boolean;
  // Default overlay scale, used on first launch and as fallback for unknown displays.
  // Window size = 192×208 × overlayScale. 1.5 = 288×312, 2 = 384×416, 3 = 576×624.
  overlayScale?: number;
  // Per-display scale memory. Key is Electron display.id (number stringified).
  // When the window moves to a display, we resize to that display's saved scale.
  // Cmd+= / Cmd+- / Cmd+0 adjust the current display's scale and save here.
  displayScales?: Record<string, number>;
  // Per-display position memory. Key is Electron display.id (number stringified).
  // Saved on user-driven moves (not wander-driven). Restored when crossing displays.
  displayPositions?: Record<string, { x: number; y: number }>;
  // Wander feature flags
  idleWanderEnabled?: boolean;
  idleWanderDelayMs?: number;
  idleWanderSpeedPxPerSec?: number;
  // Speech bubble feature flags (Phase 8)
  bubbleEnabled?: boolean;      // default true
  bubbleLifetimeMs?: number;    // default 10000 (10s per bubble)
  bubbleMaxStack?: number;      // default 5 stacked bubbles
}

// IPC channel names for main <-> renderer communication
export const IPC = {
  STATE_UPDATE: "state:update",        // main → renderer: {state, agent, message}
  PETS_LIST: "pets:list",              // renderer → main (invoke): PetManifest[]
  PET_SELECT: "pet:select",            // renderer → main (invoke): string (petId)
  SPRITESHEET_PATH: "pet:spritesheet", // renderer → main (invoke): string (abs path)
  BUBBLE_CLICK: "bubble:click",        // renderer → main (send): { agent: string }
} as const;
