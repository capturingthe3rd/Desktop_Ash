// Which side of the sprite the bubble stack appears on (Phase 11A dynamic window sizing).
// "none" = no bubbles visible; window is sprite-only.
export type BubbleSide = "above" | "below" | "left" | "right" | "none";

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

// Identifies which agent type produced a state push, enabling deep-link routing on bubble click.
// "claude-code" → open session JSONL in default editor via shell.openPath
// "codex"       → focus Codex.app (codex:// scheme exists but only handles OAuth, not sessions)
// "other"       → no-op (same as pre-Phase-12C Tier 1 fallback)
export type AgentSessionType = "claude-code" | "codex" | "other";

// Wire format for POST /state body
export interface StatePushRequest {
  state: PetState;
  ttlMs?: number;
  agent?: string;
  priority?: number;
  message?: string; // optional completion message; non-empty triggers speech bubble
  // Phase 12C — deep-link session metadata (all optional; absent = Tier 1 fallback)
  sessionId?: string;   // UUID for claude-code; JSONL stem for codex
  sessionPath?: string; // absolute path to the session JSONL file
  sessionType?: AgentSessionType;
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

// Outbound webhook configuration (Phase 12A)
export interface WebhookOutboundConfig {
  enabled: boolean;
  urls: string[];
  bearerToken?: string;
  eventFilter: {
    stateChanges: boolean;
    bubbles: boolean;
    errors: boolean;
  };
}

// Wire format for outbound webhook POSTs (Phase 12A)
export interface WebhookEvent {
  event: "state_change" | "bubble" | "error";
  state: string;
  agent: string | null;
  message: string | null;
  timestamp: number;
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
  // Outbound webhook config (Phase 12A) — off by default
  webhookOutbound?: WebhookOutboundConfig;
}

// Geometry data returned by BUBBLE_SIDE_INFO so renderer can pick bubble side.
// All values are in screen pixels. roomAbove/Below/Left/Right = px of work-area
// clearance on that side from the sprite center edge.
export interface BubbleSideInfo {
  roomAbove: number;   // px from sprite top to work-area top
  roomBelow: number;   // px from sprite bottom to work-area bottom
  roomLeft: number;    // px from sprite left to work-area left
  roomRight: number;   // px from sprite right to work-area right
}

// Activity log entry shape (matches JSONL written by activity-log.ts)
export interface ActivityLogEntry {
  ts: string;           // ISO timestamp
  session_id: string;
  type: string;         // launch, state_push, bubble_spawn, wander_phase, error, shutdown_clean, crash_detected, cleared_log, …
  data: Record<string, unknown>;
}

// Crash log entry shape (matches JSONL written by activity-log.ts detectAndLogCrash)
export interface CrashLogEntry {
  ts: string;
  sessionId: string;
  durationMs: number;
  ipsPath: string | null;
  lastActivityTs: string;
}

// IPC channel names for main <-> renderer communication
export const IPC = {
  STATE_UPDATE: "state:update",        // main → renderer: {state, agent, message}
  PETS_LIST: "pets:list",              // renderer → main (invoke): PetManifest[]
  PET_SELECT: "pet:select",            // renderer → main (invoke): string (petId)
  SPRITESHEET_PATH: "pet:spritesheet", // renderer → main (invoke): string (abs path)
  BUBBLE_CLICK: "bubble:click",        // renderer → main (send): { agent, sessionType?, sessionPath?, sessionId? }
  // Phase 9 — settings + login item IPC
  SETTINGS_GET: "settings:get",            // renderer → main (invoke): AppConfig
  SETTINGS_SAVE: "settings:save",          // renderer → main (invoke): Partial<AppConfig>
  SETTINGS_GET_DISPLAY_ID: "settings:display-id", // renderer → main (invoke): string
  LOGIN_GET: "login:get",                  // renderer → main (invoke): boolean
  LOGIN_SET: "login:set",                  // renderer → main (invoke): boolean
  // Phase 10A — activity log IPC (renderer → main, fire-and-forget send)
  ACTIVITY_LOG: "activity:log",            // renderer → main (send): {type: string, data: object}
  // Phase 11A — dynamic bubble window layout
  BUBBLE_LAYOUT: "bubble:layout",              // renderer → main (send): {side: BubbleSide, count: number}
  BUBBLE_SIDE_INFO: "bubble:side-info",        // renderer → main (invoke): BubbleSideInfo
  BUBBLE_LAYOUT_REQUEST: "bubble:layout-request", // renderer → main (invoke): {count: number} → BubbleSide
  BUBBLE_LAYOUT_CLEAR: "bubble:layout-clear",     // renderer → main (send): no payload
  // Phase 11B — activity dashboard reads + clear
  ACTIVITY_LOG_READ: "activity:read",      // renderer → main (invoke): ActivityLogEntry[]
  ACTIVITY_LOG_CLEAR: "activity:clear",    // renderer → main (invoke): { ok: true }
  CRASH_LOG_READ: "crash:read",            // renderer → main (invoke): CrashLogEntry[]
} as const;
