import { contextBridge, ipcRenderer } from "electron";

// Preload runs in a sandboxed context that cannot require arbitrary local modules.
// IPC channel names are inlined here rather than imported from shared/types.js.
// If you change these, also update src/shared/types.ts IPC constants — they must match.
const IPC = {
  STATE_UPDATE: "state:update",
  PETS_LIST: "pets:list",
  PET_SELECT: "pet:select",
  SPRITESHEET_PATH: "pet:spritesheet",
} as const;

// PetManifest type is intentionally not imported — preload only forwards opaque values.
contextBridge.exposeInMainWorld("ash", {
  listPets: (): Promise<unknown[]> => ipcRenderer.invoke(IPC.PETS_LIST),
  selectPet: (petId: string): Promise<string> => ipcRenderer.invoke(IPC.PET_SELECT, petId),
  getSpritesheetPath: (): Promise<string | null> => ipcRenderer.invoke(IPC.SPRITESHEET_PATH),
  onStateUpdate: (callback: (state: string) => void) => {
    ipcRenderer.on(IPC.STATE_UPDATE, (_event, state: string) => callback(state));
  },
});
