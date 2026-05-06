import { app, BrowserWindow, protocol, net, ipcMain, screen } from "electron";
import path from "path";
import { loadConfig, saveConfig } from "./config.js";
import { scanPets } from "./pet-scanner.js";
import { StateQueue } from "./state-queue.js";
import { createServer } from "./server.js";
import { registerIpcHandlers, broadcastState } from "./ipc.js";
import * as codexBridge from "../codex-bridge/index.js";
import { IPC } from "../shared/types.js";
import type { PetManifest } from "../shared/types.js";

// Force userData dir to match plan-specified path (~/Library/Application Support/Desktop_Ash).
// Without this, Electron uses package.json `name` (lowercase "desktop_ash" — npm requires lowercase).
// Must run before any app.getPath("userData") call (config.ts uses lazy getter so this is fine).
app.setName("Desktop_Ash");

// Singleton: only one Desktop Ash window allowed
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
  process.exit(0);
}

let overlayWin: BrowserWindow | null = null;
let pickerWin: BrowserWindow | null = null;

// State queue is instantiated here so server and IPC can share it
const queue = new StateQueue((state) => {
  if (overlayWin && !overlayWin.isDestroyed()) {
    broadcastState(overlayWin, state);
  }
});

// Register ash-asset:// protocol BEFORE app is ready.
// This lets renderer load pet spritesheets from ~/.codex/pets/ via:
//   ash-asset://<absolute-path>  — for the renderer (spritesheet)
// We intercept and serve the file via net.fetch.
protocol.registerSchemesAsPrivileged([
  {
    scheme: "ash-asset",
    privileges: {
      secure: true,
      bypassCSP: true,
      supportFetchAPI: true,
      corsEnabled: false,
    },
  },
]);

function createPickerWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 420,
    height: 520,
    resizable: false,
    center: true,
    title: "Desktop Ash — Choose Your Pet",
    webPreferences: {
      preload: path.join(__dirname, "../renderer/preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const rendererDist = path.join(app.getAppPath(), "dist/renderer");
  win.loadFile(path.join(rendererDist, "picker.html"));

  win.on("closed", () => {
    pickerWin = null;
  });

  return win;
}

// Scale clamps — keep Ash visible but not absurd.
const MIN_SCALE = 0.5;
const MAX_SCALE = 5;
const SCALE_STEP = 0.25;
const DEFAULT_SCALE = 1.5;

// Read the scale to use for a given display id from config (per-display memory).
// Falls back to top-level overlayScale, then DEFAULT_SCALE.
function scaleForDisplay(displayId: string): number {
  const cfg = loadConfig();
  const perDisplay = cfg.displayScales?.[displayId];
  if (typeof perDisplay === "number" && perDisplay > 0) return perDisplay;
  if (typeof cfg.overlayScale === "number" && cfg.overlayScale > 0) return cfg.overlayScale;
  return DEFAULT_SCALE;
}

// Persist the scale for a specific display.
function saveScaleForDisplay(displayId: string, scale: number): void {
  const cfg = loadConfig();
  const next = { ...(cfg.displayScales ?? {}) };
  next[displayId] = scale;
  saveConfig({ ...cfg, displayScales: next });
}

// Resize the overlay window in place, keeping it centered on its current position.
function resizeOverlay(win: BrowserWindow, scale: number): void {
  const w = Math.round(192 * scale);
  const h = Math.round(208 * scale);
  const cur = win.getBounds();
  // Keep visual center stable rather than top-left
  const cx = cur.x + cur.width / 2;
  const cy = cur.y + cur.height / 2;
  win.setBounds({
    x: Math.round(cx - w / 2),
    y: Math.round(cy - h / 2),
    width: w,
    height: h,
  });
}

function createOverlayWindow(): BrowserWindow {
  // Base cell 192×208. Initial scale = whichever display the cursor is on saved scale.
  const cursor = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursor);
  const scale = scaleForDisplay(String(display.id));
  const win = new BrowserWindow({
    width: Math.round(192 * scale),
    height: Math.round(208 * scale),
    transparent: true,
    frame: false,
    hasShadow: false,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    webPreferences: {
      preload: path.join(__dirname, "../renderer/preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Keep above full-screen apps and across all Spaces
  win.setAlwaysOnTop(true, "screen-saver");
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  const rendererDist = path.join(app.getAppPath(), "dist/renderer");
  win.loadFile(path.join(rendererDist, "index.html"));

  // Track which display the window is on so we can restore per-display scale
  // when it crosses into a different monitor.
  let lastDisplayId = String(display.id);
  let moveDebounce: ReturnType<typeof setTimeout> | null = null;
  win.on("move", () => {
    if (moveDebounce !== null) clearTimeout(moveDebounce);
    moveDebounce = setTimeout(() => {
      moveDebounce = null;
      if (win.isDestroyed()) return;
      const center = screen.getDisplayMatching(win.getBounds());
      const newId = String(center.id);
      if (newId !== lastDisplayId) {
        lastDisplayId = newId;
        const newScale = scaleForDisplay(newId);
        resizeOverlay(win, newScale);
        console.log(`[main] crossed to display ${newId}, applied scale ${newScale}`);
      }
    }, 150);
  });

  // Cmd+=, Cmd+- (also Cmd+_), Cmd+0 to adjust + persist scale for current display.
  // before-input-event fires before the renderer sees the keystroke; we intercept here.
  win.webContents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown" || !input.meta) return;
    const k = input.key;
    const isPlus = k === "=" || k === "+";
    const isMinus = k === "-" || k === "_";
    const isZero = k === "0";
    if (!isPlus && !isMinus && !isZero) return;
    event.preventDefault();
    const id = String(screen.getDisplayMatching(win.getBounds()).id);
    const current = scaleForDisplay(id);
    let next = current;
    if (isPlus) next = Math.min(MAX_SCALE, current + SCALE_STEP);
    else if (isMinus) next = Math.max(MIN_SCALE, current - SCALE_STEP);
    else if (isZero) next = DEFAULT_SCALE;
    if (next === current) return;
    resizeOverlay(win, next);
    saveScaleForDisplay(id, next);
    console.log(`[main] scale ${current} → ${next} on display ${id}`);
  });

  win.on("closed", () => {
    if (moveDebounce !== null) clearTimeout(moveDebounce);
    overlayWin = null;
    queue.destroy();
  });

  return win;
}

// If a second instance is launched, focus the existing window
app.on("second-instance", () => {
  const target = overlayWin ?? pickerWin;
  if (target && !target.isDestroyed()) {
    if (target.isMinimized()) target.restore();
    target.focus();
  }
});

app.whenReady().then(() => {
  // Register the ash-asset:// protocol handler
  protocol.handle("ash-asset", (request) => {
    // URL is: ash-asset://<absolute-path-to-file>
    // We strip the protocol prefix and serve from the filesystem
    const rawPath = request.url.slice("ash-asset://".length);
    const filePath = decodeURIComponent(rawPath);
    return net.fetch(`file://${filePath}`);
  });

  // Register IPC handlers
  registerIpcHandlers();

  // PET_SELECT is handled here (not in ipc.ts) so we can close the picker window
  // after persisting the choice. ipc.ts already registered a generic handler — remove it
  // and override here. (ipcMain.removeHandler is idempotent if the channel wasn't set.)
  ipcMain.removeHandler(IPC.PET_SELECT);
  ipcMain.handle(IPC.PET_SELECT, (_event, petId: string) => {
    const cfg = loadConfig();
    cfg.selectedPetId = petId;
    saveConfig(cfg);
    // Close picker; the "closed" handler below opens the overlay.
    if (pickerWin && !pickerWin.isDestroyed()) {
      pickerWin.close();
    }
    return petId;
  });

  // Start HTTP server
  createServer(queue);

  // Start the Codex bridge if the user has opted in via config
  const config = loadConfig();
  if (config.codexBridgeEnabled) {
    codexBridge.start();
  }

  // Decide which window to open first
  if (!config.selectedPetId) {
    // First run: show pet picker
    pickerWin = createPickerWindow();

    // After picker closes, open the overlay (pet was selected and saved)
    pickerWin.on("closed", () => {
      const freshConfig = loadConfig();
      if (freshConfig.selectedPetId) {
        overlayWin = createOverlayWindow();
      }
    });
  } else {
    // Pet already selected: go straight to overlay
    overlayWin = createOverlayWindow();
  }

  // Verify the selected pet still exists (user may have deleted it)
  if (config.selectedPetId) {
    const pets: PetManifest[] = scanPets();
    const petExists = pets.some((p) => p.id === config.selectedPetId);
    if (!petExists) {
      console.warn(`[main] selected pet "${config.selectedPetId}" no longer exists, resetting to picker`);
      // Clear config and reopen as first run
      saveConfig({ selectedPetId: null });
      if (overlayWin && !overlayWin.isDestroyed()) overlayWin.close();
      pickerWin = createPickerWindow();
    }
  }
});

// Stop the Codex bridge before the process exits
app.on("quit", () => {
  codexBridge.stop();
});

// Keep alive on macOS (standard convention: don't quit when all windows closed)
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    queue.destroy();
    app.quit();
  }
});

app.on("activate", () => {
  // Re-open when dock icon clicked (macOS)
  if (overlayWin === null && pickerWin === null) {
    const config = loadConfig();
    if (config.selectedPetId) {
      overlayWin = createOverlayWindow();
    } else {
      pickerWin = createPickerWindow();
    }
  }
});
