import { contextBridge, ipcRenderer } from "electron";

// Preload runs in a sandboxed context that cannot require arbitrary local modules.
// IPC channel names are inlined here rather than imported from shared/types.js.
// If you change these, also update src/shared/types.ts IPC constants — they must match.
const IPC = {
  STATE_UPDATE: "state:update",
  PETS_LIST: "pets:list",
  PET_SELECT: "pet:select",
  SPRITESHEET_PATH: "pet:spritesheet",
  BUBBLE_CLICK: "bubble:click",
  // Phase 9 — settings + login item
  SETTINGS_GET: "settings:get",
  SETTINGS_SAVE: "settings:save",
  SETTINGS_GET_DISPLAY_ID: "settings:display-id",
  LOGIN_GET: "login:get",
  LOGIN_SET: "login:set",
  // Phase 10A — activity log (renderer → main, fire-and-forget)
  ACTIVITY_LOG: "activity:log",
  // Phase 11A — dynamic bubble window layout
  BUBBLE_LAYOUT: "bubble:layout",
  BUBBLE_SIDE_INFO: "bubble:side-info",
  BUBBLE_LAYOUT_REQUEST: "bubble:layout-request",
  BUBBLE_LAYOUT_CLEAR: "bubble:layout-clear",
  // Phase 11B — activity dashboard reads + clear
  ACTIVITY_LOG_READ: "activity:read",
  ACTIVITY_LOG_CLEAR: "activity:clear",
  CRASH_LOG_READ: "crash:read",
} as const;

interface StateUpdatePayload {
  state: string;
  agent: string | null;
  message: string | null;
  // Phase 12C — session metadata passed through from the state push for deep-link routing
  sessionId: string | null;
  sessionPath: string | null;
  sessionType: string | null;
}

// PetManifest type is intentionally not imported — preload only forwards opaque values.
contextBridge.exposeInMainWorld("ash", {
  listPets: (): Promise<unknown[]> => ipcRenderer.invoke(IPC.PETS_LIST),
  selectPet: (petId: string): Promise<string> => ipcRenderer.invoke(IPC.PET_SELECT, petId),
  getSpritesheetPath: (): Promise<string | null> => ipcRenderer.invoke(IPC.SPRITESHEET_PATH),
  // Renderer subscribes to {state, agent, message} payloads. Callback receives all three;
  // sprite animator uses state, bubble manager uses agent + message.
  onStateUpdate: (callback: (payload: StateUpdatePayload) => void) => {
    ipcRenderer.on(IPC.STATE_UPDATE, (_event, payload: StateUpdatePayload) => callback(payload));
  },
  // Left-click on a bubble — main process deep-links to the session (Phase 12C).
  // Passes session metadata so main can open the specific session file (Tier 2).
  // Falls back to terminal/app focus if metadata is absent (Tier 1).
  clickBubble: (agent: string | null, sessionType: string | null, sessionPath: string | null, sessionId: string | null) => {
    ipcRenderer.send(IPC.BUBBLE_CLICK, { agent, sessionType, sessionPath, sessionId });
  },
  // Phase 10A — fire-and-forget activity log from renderer (bubble spawns, etc.)
  // Renderer is sandboxed and cannot import main-process modules; relay via IPC.
  logActivity: (type: string, data: object) => {
    ipcRenderer.send(IPC.ACTIVITY_LOG, { type, data });
  },
  // Phase 11A — query main for sprite clearance geometry so renderer can pick side.
  getBubbleSideInfo: (): Promise<unknown> => ipcRenderer.invoke(IPC.BUBBLE_SIDE_INFO),
  // Phase 11A — notify main of bubble layout change so it can resize the window.
  sendBubbleLayout: (side: string, count: number) => {
    ipcRenderer.send(IPC.BUBBLE_LAYOUT, { side, count });
  },
  // Phase 11A v2 — request main to pick side, resize window, return chosen side.
  requestBubbleLayout: (count: number): Promise<string> =>
    ipcRenderer.invoke(IPC.BUBBLE_LAYOUT_REQUEST, { count }),
  // Phase 11A v2 — notify main that all bubbles faded; shrink to sprite-only.
  clearBubbleLayout: () => {
    ipcRenderer.send(IPC.BUBBLE_LAYOUT_CLEAR);
  },
  // Phase 9 settings window APIs
  getSettings: (): Promise<unknown> => ipcRenderer.invoke(IPC.SETTINGS_GET),
  saveSettings: (partial: unknown): Promise<unknown> => ipcRenderer.invoke(IPC.SETTINGS_SAVE, partial),
  getCurrentDisplayId: (): Promise<string | null> => ipcRenderer.invoke(IPC.SETTINGS_GET_DISPLAY_ID),
  getOpenAtLogin: (): Promise<boolean> => ipcRenderer.invoke(IPC.LOGIN_GET),
  setOpenAtLogin: (openAtLogin: boolean): Promise<boolean> => ipcRenderer.invoke(IPC.LOGIN_SET, openAtLogin),
  // Phase 11B — activity dashboard
  readActivityLog: (): Promise<unknown[]> => ipcRenderer.invoke(IPC.ACTIVITY_LOG_READ),
  readCrashLog: (): Promise<unknown[]> => ipcRenderer.invoke(IPC.CRASH_LOG_READ),
  clearActivityLog: (): Promise<{ ok: boolean }> => ipcRenderer.invoke(IPC.ACTIVITY_LOG_CLEAR),
});
