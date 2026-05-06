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
} as const;

interface StateUpdatePayload {
  state: string;
  agent: string | null;
  message: string | null;
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
  // Left-click on a bubble — main process focuses the agent's app via osascript.
  clickBubble: (agent: string | null) => {
    ipcRenderer.send(IPC.BUBBLE_CLICK, { agent });
  },
  // Phase 9 settings window APIs
  getSettings: (): Promise<unknown> => ipcRenderer.invoke(IPC.SETTINGS_GET),
  saveSettings: (partial: unknown): Promise<unknown> => ipcRenderer.invoke(IPC.SETTINGS_SAVE, partial),
  getCurrentDisplayId: (): Promise<string | null> => ipcRenderer.invoke(IPC.SETTINGS_GET_DISPLAY_ID),
  getOpenAtLogin: (): Promise<boolean> => ipcRenderer.invoke(IPC.LOGIN_GET),
  setOpenAtLogin: (openAtLogin: boolean): Promise<boolean> => ipcRenderer.invoke(IPC.LOGIN_SET, openAtLogin),
});
