import { ipcMain, BrowserWindow } from "electron";
import { IPC } from "../shared/types.js";
import { scanPets, resolveSpritesheetPath } from "./pet-scanner.js";
import { loadConfig, saveConfig } from "./config.js";

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
}

// Push a state update from the main process to the renderer.
// Called by the state queue's onStateChange callback.
export function broadcastState(win: BrowserWindow, state: string): void {
  if (win.isDestroyed()) return;
  win.webContents.send(IPC.STATE_UPDATE, state);
}
