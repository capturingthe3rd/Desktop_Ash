import { app, BrowserWindow, protocol, net, ipcMain, screen, Menu } from "electron";
import { exec } from "child_process";
import path from "path";
import { loadConfig, saveConfig } from "./config.js";
import { scanPets } from "./pet-scanner.js";
import { StateQueue } from "./state-queue.js";
import { createServer } from "./server.js";
import { registerIpcHandlers, broadcastState } from "./ipc.js";
import * as codexBridge from "../codex-bridge/index.js";
import { startWanderManager } from "./wander.js";
import type { WanderHandle } from "./wander.js";
import { IPC } from "../shared/types.js";
import type { PetManifest, AppConfig } from "../shared/types.js";
import { startTray } from "./tray.js";
import { initActivityLog, logActivity, markCleanShutdown, getLogsDir, getLatestCrashReportPath, hasCrashLog } from "./activity-log.js";

// Force userData dir to match plan-specified path (~/Library/Application Support/Desktop_Ash).
// Without this, Electron uses package.json `name` (lowercase "desktop_ash" — npm requires lowercase).
// Must run before any app.getPath("userData") call (config.ts uses lazy getter so this is fine).
app.setName("Desktop_Ash");

// Disable the global application menu. We use a tray for all user actions, and
// keeping a native app menu around triggers a Chromium/macOS event-dispatch path
// that segfaults on right-click of the transparent overlay (Electron 42 + macOS
// 26.3 — confirmed via crash report: NSEvent processing → null deref in
// _updateCanQuitQuietlyAndSafely → CrBrowserMain segfault). Removing the menu
// avoids the crashing code path entirely.
Menu.setApplicationMenu(null);

// Singleton: only one Desktop Ash window allowed
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
  process.exit(0);
}

let overlayWin: BrowserWindow | null = null;
let pickerWin: BrowserWindow | null = null;
let settingsWin: BrowserWindow | null = null;
let wanderHandle: WanderHandle | null = null;

// Drag-direction tracking — updated inside the will-move handler.
// lastDragX: window.x at the previous will-move event (null = first event of this drag session).
// lastDragPushAt: Date.now() when we last pushed a running-* state for drag.
// lastDragDirection: the direction we last pushed so purely-vertical drags keep facing stable.
let lastDragX: number | null = null;
let lastDragPushAt: number = 0;
let lastDragDirection: "running-right" | "running-left" = "running-right";

// True only when user has explicitly chosen to quit (tray Quit, Cmd+Q).
// The overlay window's close handler reads this to decide hide vs. destroy.
// Without this flag, accidental close paths (right-click → Close, native macOS
// window-menu Close) would destroy Ash and leave the user stranded.
let isQuitting = false;

// Reserved pixel height above the sprite for speech bubbles. Constant — window
// is sized once at startup to include this area; no dynamic resize needed.
const BUBBLE_AREA_HEIGHT = 280;
// Minimum window width so bubbles get a wide reading area, not a tall narrow column.
// Window is max(192*scale, BUBBLE_MIN_WIDTH) wide. At 0.75x scale (sprite=144px)
// the window ends up 360px wide, sprite centered horizontally with transparent margins.
const BUBBLE_MIN_WIDTH = 360;

// State queue is instantiated here so server and IPC can share it.
// Initial subscriber forwards all three args to the renderer.
const queue = new StateQueue((state, agent, message) => {
  if (overlayWin && !overlayWin.isDestroyed()) {
    broadcastState(overlayWin, state, agent, message);
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

function createSettingsWindow(): BrowserWindow {
  // Singleton — only one settings window at a time. Caller checks settingsWin first.
  const win = new BrowserWindow({
    width: 480,
    height: 520,
    resizable: false,
    center: true,
    title: "Desktop Ash — Settings",
    webPreferences: {
      preload: path.join(__dirname, "../renderer/preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const rendererDist = path.join(app.getAppPath(), "dist/renderer");
  win.loadFile(path.join(rendererDist, "settings.html"));

  win.on("closed", () => {
    settingsWin = null;
  });

  return win;
}

function openSettings(): void {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.focus();
    return;
  }
  settingsWin = createSettingsWindow();
}

function openPicker(): void {
  if (pickerWin && !pickerWin.isDestroyed()) {
    pickerWin.focus();
    return;
  }
  pickerWin = createPickerWindow();
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

// Read the saved {x,y} position for a specific display id. Returns null if not yet saved.
function boundsForDisplay(displayId: string): { x: number; y: number } | null {
  const cfg = loadConfig();
  return cfg.displayPositions?.[displayId] ?? null;
}

// Persist the current {x,y} position for a specific display id.
function saveBoundsForDisplay(displayId: string, bounds: { x: number; y: number }): void {
  const cfg = loadConfig();
  const next = { ...(cfg.displayPositions ?? {}) };
  next[displayId] = { x: bounds.x, y: bounds.y };
  saveConfig({ ...cfg, displayPositions: next });
}

// Resize the overlay window in place, keeping the SPRITE center stable (not window center).
// Window height = BUBBLE_AREA_HEIGHT + 208*scale. Sprite center is at
// window.y + BUBBLE_AREA_HEIGHT + (208*scale)/2. We preserve that y coordinate.
function resizeOverlay(win: BrowserWindow, scale: number): void {
  const spriteH = Math.round(208 * scale);
  const w = Math.max(Math.round(192 * scale), BUBBLE_MIN_WIDTH);
  const h = BUBBLE_AREA_HEIGHT + spriteH;
  const cur = win.getBounds();
  // Sprite center Y in screen coords (stays fixed across resize)
  const prevSpriteH = cur.height - BUBBLE_AREA_HEIGHT;
  const spriteCenterY = cur.y + BUBBLE_AREA_HEIGHT + prevSpriteH / 2;
  // Compute new window top-left so sprite center stays at spriteCenterY
  const newY = Math.round(spriteCenterY - BUBBLE_AREA_HEIGHT - spriteH / 2);
  const cx = cur.x + cur.width / 2;
  win.setBounds({
    x: Math.round(cx - w / 2),
    y: newY,
    width: w,
    height: h,
  });
}

function createOverlayWindow(): BrowserWindow {
  // Width = max(192*scale, 240) to fit bubble min-width. Height = BUBBLE_AREA_HEIGHT + 208*scale.
  const cursor = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursor);
  const scale = scaleForDisplay(String(display.id));
  const win = new BrowserWindow({
    width: Math.max(Math.round(192 * scale), BUBBLE_MIN_WIDTH),
    height: BUBBLE_AREA_HEIGHT + Math.round(208 * scale),
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
  // and per-display position when it crosses into a different monitor.
  let lastDisplayId = String(display.id);
  let moveDebounce: ReturnType<typeof setTimeout> | null = null;

  // will-move fires only for manual user drag — NOT for programmatic setBounds.
  // This is how we distinguish "Capt grabbed the pet" from "wander stepped the window."
  // Calling notifyUserDrag here cancels any in-progress wander walk so the user
  // can drag freely without wander fighting them.
  // (If this proves to fire for setBounds in some Electron builds, we'd see wander
  // self-cancel on every walk tick — easily spotted in /tmp/desktop_ash.log.)
  win.on("will-move", (_event, newBounds) => {
    // Cancel wander FIRST so it yields before we push the drag direction.
    if (wanderHandle?.isWandering()) {
      console.log("[main] user drag detected (will-move) — yielding wander");
      wanderHandle.notifyUserDrag();
    }

    // Drag-direction running animation.
    // Use the newBounds parameter Electron provides — that's the proposed new
    // position. win.getBounds() at this moment returns the OLD position which
    // gives unreliable deltas (and bounds-jitter on click-without-drag would
    // trigger spurious left/right alternation).
    const currentX = newBounds.x;
    const now = Date.now();

    // Reset tracking if there's been a long gap since last will-move — means
    // the previous drag ended. Without this, a click after a previous drag
    // computes delta against the OLD drag's last position, causing a spurious
    // push in the wrong direction.
    if (lastDragPushAt > 0 && now - lastDragPushAt > 300) {
      lastDragX = null;
    }

    if (lastDragX === null) {
      // First event of this drag session — initialize tracking, no push yet.
      lastDragX = currentX;
      return;
    }

    const deltaX = currentX - lastDragX;
    lastDragX = currentX;

    // Threshold raised to 20px to filter macOS bounds-jitter on mousedown.
    // A genuine drag covers 50-300px in well under 100ms; 20px filters noise
    // while staying responsive to real movement.
    if (Math.abs(deltaX) < 20) return;

    const directionChanged =
      (deltaX > 0 && lastDragDirection !== "running-right") ||
      (deltaX < 0 && lastDragDirection !== "running-left");
    const throttleElapsed = now - lastDragPushAt >= 100;

    if (directionChanged || throttleElapsed) {
      const direction: "running-right" | "running-left" =
        deltaX > 0 ? "running-right" : "running-left";
      lastDragDirection = direction;
      lastDragPushAt = now;
      queue.push(direction, { priority: -1, ttlMs: 1500, agent: "drag" });
    }
  });

  win.on("move", () => {
    if (moveDebounce !== null) clearTimeout(moveDebounce);
    moveDebounce = setTimeout(() => {
      moveDebounce = null;
      if (win.isDestroyed()) return;
      const center = screen.getDisplayMatching(win.getBounds());
      const newId = String(center.id);

      if (newId === lastDisplayId) {
        // Same display — save position only when the user drove the move (not wander).
        if (!(wanderHandle?.isWandering() ?? false)) {
          saveBoundsForDisplay(newId, win.getBounds());
          wanderHandle?.notifyUserDrag();
        }
      } else {
        // Crossed to a new display — restore scale and saved position.
        lastDisplayId = newId;
        const newScale = scaleForDisplay(newId);
        resizeOverlay(win, newScale);
        console.log(`[main] crossed to display ${newId}, applied scale ${newScale}`);
        const savedPos = boundsForDisplay(newId);
        if (savedPos) {
          const b = win.getBounds();
          win.setBounds({ ...b, x: savedPos.x, y: savedPos.y });
          console.log(`[main] restored position for display ${newId}: (${savedPos.x},${savedPos.y})`);
        }
        // Display crossing cancels any in-progress wander.
        wanderHandle?.notifyUserDrag();
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

  // Intercept ALL close attempts on the overlay (right-click → Close, macOS
  // window menu, Cmd+W if the renderer ever wired one). Hide instead so the
  // user can re-show via tray. Only when isQuitting is set (tray Quit / Cmd+Q)
  // do we let the close go through normally.
  win.on("close", (e) => {
    if (!isQuitting) {
      e.preventDefault();
      win.hide();
      console.log("[main] overlay close intercepted → hidden (use tray to re-show)");
    }
  });

  win.on("closed", () => {
    if (moveDebounce !== null) clearTimeout(moveDebounce);
    // Reset drag-tracking so a re-opened overlay starts with no stale delta.
    lastDragX = null;
    overlayWin = null;
    queue.destroy();
  });

  return win;
}

// Open the overlay window AND wire the wander manager + state-queue subscription.
// All overlay creation paths must go through here so wander stays consistent.
function openOverlay(): BrowserWindow {
  const win = createOverlayWindow();
  wanderHandle = startWanderManager(win, queue);
  // Third arg (message) is irrelevant to wander — ignored via _message parameter.
  const unsubscribe = queue.subscribe((state, agent, _message) => wanderHandle?.notifyStateChange(state, agent));
  win.on("closed", () => {
    unsubscribe();
    wanderHandle?.stop();
    wanderHandle = null;
  });
  return win;
}

// If a second instance is launched, focus the existing window
// Set the "user is quitting" flag so the overlay close interceptor knows to let
// the close go through. Tray Quit, Cmd+Q, and "Quit Desktop Ash" menu items
// all flow through before-quit before destroying windows.
// markCleanShutdown() runs first so the heartbeat is deleted before any window
// teardown, ensuring crash detection on the next launch is accurate.
app.on("before-quit", () => {
  markCleanShutdown();
  isQuitting = true;
});

app.on("second-instance", () => {
  const target = overlayWin ?? pickerWin;
  if (target && !target.isDestroyed()) {
    if (target.isMinimized()) target.restore();
    target.focus();
  }
});

app.whenReady().then(() => {
  // Activity log must init before any window creation so the launch event and
  // crash detection run before anything else can write to the log.
  initActivityLog();

  // Log every state push — agent and hasMessage only, never the message body.
  queue.subscribe((state, agent, message) => {
    logActivity("state_push", { state, agent, hasMessage: message !== null && message.length > 0 });
  });

  // Relay activity log events from the sandboxed renderer process.
  ipcMain.on(IPC.ACTIVITY_LOG, (_event, payload: { type: string; data: object }) => {
    if (typeof payload?.type === "string") {
      logActivity(payload.type, payload.data ?? {});
    }
  });

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

  // BUBBLE_CLICK: renderer left-clicked a bubble → bring agent app to front.
  // Fire-and-forget AppleScript. Never throws to the renderer — non-blocking by design.
  ipcMain.on(IPC.BUBBLE_CLICK, (_event, payload: { agent: string }) => {
    const agent = payload?.agent ?? "";
    console.log(`[bubble] click → agent="${agent}"`);

    if (agent === "claude-code") {
      // Try iTerm2 first, fall back to Terminal.
      const script = `
        tell application "System Events"
          set itermRunning to (count of (every process whose name is "iTerm2")) > 0
        end tell
        if itermRunning then
          tell application "iTerm2" to activate
        else
          tell application "Terminal" to activate
        end if
      `;
      exec(`osascript -e '${script.replace(/'/g, "'\\''")}'`, (err: Error | null) => {
        if (err) console.log(`[bubble] osascript iTerm2/Terminal: ${err.message}`);
      });
    } else if (agent === "codex") {
      // Codex Desktop may be named "Codex" or "ChatGPT" depending on version.
      exec(`osascript -e 'tell application "Codex" to activate' 2>/dev/null || osascript -e 'tell application "ChatGPT" to activate'`, (err: Error | null) => {
        if (err) console.log(`[bubble] osascript Codex/ChatGPT: ${err.message}`);
      });
    } else {
      console.log(`[bubble] no app target for agent "${agent}" — no-op`);
    }
  });

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

  // SETTINGS_SAVE: merge partial config into saved config, apply live changes where possible.
  // Lives here (not ipc.ts) because applying wander changes requires wanderHandle reference.
  ipcMain.handle(IPC.SETTINGS_SAVE, (_event, partial: Partial<AppConfig>) => {
    const cfg = loadConfig();
    const next: AppConfig = { ...cfg, ...partial };
    saveConfig(next);

    // Apply wander changes immediately without restart
    if (wanderHandle && (
      partial.idleWanderEnabled !== undefined ||
      partial.idleWanderDelayMs !== undefined ||
      partial.idleWanderSpeedPxPerSec !== undefined
    )) {
      // Restart wander manager with new config by stopping then signalling idle.
      // The manager reads loadConfig() on construction — saveConfig above already wrote it.
      // We re-use the existing wanderHandle's stop + bootstrap approach:
      // stop cancels all timers; on the next idle the queue will rearm it.
      // Full restart would need openOverlay — simpler to just stop + let idle rearm.
      wanderHandle.stop();
      // If idleWanderEnabled was just disabled, leave stopped. Otherwise re-arm.
      if (next.idleWanderEnabled !== false) {
        wanderHandle.resume();
      }
    }

    return next;
  });

  // SETTINGS_GET_DISPLAY_ID: returns the display ID the overlay window is currently on.
  // Settings UI shows this so user knows which display's scale they're editing.
  ipcMain.handle(IPC.SETTINGS_GET_DISPLAY_ID, () => {
    if (!overlayWin || overlayWin.isDestroyed()) return null;
    const display = screen.getDisplayMatching(overlayWin.getBounds());
    return String(display.id);
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
        overlayWin = openOverlay();
      }
    });
  } else {
    // Pet already selected: go straight to overlay
    overlayWin = openOverlay();
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

  // Start the menubar tray icon. Must be created after app is ready (Tray API requires it).
  // Deps use closures over module-level vars so the menu always reflects current state.
  startTray({
    overlayWin: () => overlayWin,
    wanderHandle: () => wanderHandle,
    openSettings,
    openPicker,
    getLogsDir,
    getLatestCrashReportPath,
    hasCrashLog,
    logActivity,
  });
});

// Stop the Codex bridge + wander manager before the process exits
app.on("quit", () => {
  codexBridge.stop();
  wanderHandle?.stop();
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
      overlayWin = openOverlay();
    } else {
      pickerWin = createPickerWindow();
    }
  }
});
