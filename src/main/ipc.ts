import { ipcMain, BrowserWindow, app } from "electron";
import { IPC } from "../shared/types.js";
import { scanPets, resolveSpritesheetPath } from "./pet-scanner.js";
import { loadConfig, saveConfig } from "./config.js";
import { readActivityLog, readCrashLog, clearActivityLog } from "./activity-log.js";

// Register all IPC handlers for renderer↔main communication.
// Separated here so main.ts stays readable.
// queue is not needed here — state pushes flow main→renderer via broadcastState.
export function registerIpcHandlers(): void {
  // Renderer asks for the full pet list (first-run picker)
  ipcMain.handle(IPC.PETS_LIST, () => {
    return scanPets();
  });

  // Renderer tells us which pet was selected; persist and return spritesheet path
  ipcMain.handle(IPC.PET_SELECT, (_event, petId: string) => {
    const config = loadConfig();
    config.selectedPetId = petId;
    saveConfig(config);
    return petId;
  });

  // Renderer asks for the absolute spritesheet path of the currently selected pet
  ipcMain.handle(IPC.SPRITESHEET_PATH, () => {
    const config = loadConfig();
    const petId = config.selectedPetId;
    if (!petId) return null;

    const pets = scanPets();
    const pet = pets.find((p) => p.id === petId);
    if (!pet) return null;

    return resolveSpritesheetPath(pet.id, pet.spritesheetPath);
  });

  // Settings: return current full config to the settings window
  ipcMain.handle(IPC.SETTINGS_GET, () => {
    return loadConfig();
  });

  // Login item: read current state
  ipcMain.handle(IPC.LOGIN_GET, () => {
    return app.getLoginItemSettings().openAtLogin;
  });

  // Login item: set and return new state
  ipcMain.handle(IPC.LOGIN_SET, (_event, openAtLogin: boolean) => {
    app.setLoginItemSettings({ openAtLogin, openAsHidden: false });
    return app.getLoginItemSettings().openAtLogin;
  });

  // Phase 11B — activity dashboard
  ipcMain.handle(IPC.ACTIVITY_LOG_READ, () => {
    return readActivityLog(500);
  });

  ipcMain.handle(IPC.CRASH_LOG_READ, () => {
    return readCrashLog(100);
  });

  ipcMain.handle(IPC.ACTIVITY_LOG_CLEAR, () => {
    clearActivityLog();
    return { ok: true };
  });
}

// Push a state update from the main process to the renderer.
// Payload expanded to {state, agent, message} so renderer bubble manager can act on message.
export function broadcastState(win: BrowserWindow, state: string, agent: string | null, message: string | null): void {
  if (win.isDestroyed()) return;
  win.webContents.send(IPC.STATE_UPDATE, { state, agent, message });
}
