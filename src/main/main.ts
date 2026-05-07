import { app, BrowserWindow, protocol, net, ipcMain, screen, Menu, dialog, Notification } from "electron";
import { autoUpdater } from "electron-updater";
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
import type { PetManifest, AppConfig, BubbleSide } from "../shared/types.js";
import { startTray } from "./tray.js";
import { initActivityLog, logActivity, markCleanShutdown, getLogsDir, getLatestCrashReportPath, hasCrashLog } from "./activity-log.js";
import { dispatchWebhook } from "./webhook-outbound.js";

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

// Fixed pixel dimensions for the bubble area alongside the sprite.
// BUBBLE_AREA_TALL: height of bubble area when stacked above or below the sprite.
// BUBBLE_AREA_WIDE: width of bubble area when placed left or right of the sprite.
const BUBBLE_AREA_TALL = 280;
const BUBBLE_AREA_WIDE = 240;

// Phase 11A — current bubble side state. "none" = sprite-only window.
// Persists across bubble stacks; reset to "none" when BUBBLE_LAYOUT_CLEAR fires.
let currentBubbleSide: BubbleSide = "none";

// Returns where the sprite's top-left corner sits inside the overlay window,
// given the current bubble side layout. Origin = window top-left.
function getSpriteOffsetInWindow(side: BubbleSide, scale: number): { x: number; y: number } {
  const spriteW = Math.round(192 * scale);
  const spriteH = Math.round(208 * scale);
  switch (side) {
    case "above":
      // Bubble area on top; sprite below it. Sprite is centered horizontally.
      return { x: Math.round((Math.max(spriteW, BUBBLE_AREA_WIDE) - spriteW) / 2), y: BUBBLE_AREA_TALL };
    case "below":
      // Sprite on top; bubble area below. Sprite centered horizontally.
      return { x: Math.round((Math.max(spriteW, BUBBLE_AREA_WIDE) - spriteW) / 2), y: 0 };
    case "left":
      // Bubble area on left; sprite on right. Sprite centered vertically.
      return { x: BUBBLE_AREA_WIDE, y: Math.round((Math.max(spriteH, BUBBLE_AREA_WIDE) - spriteH) / 2) };
    case "right":
      // Sprite on left; bubble area on right. Sprite centered vertically.
      return { x: 0, y: Math.round((Math.max(spriteH, BUBBLE_AREA_WIDE) - spriteH) / 2) };
    case "none":
    default:
      return { x: 0, y: 0 };
  }
}

// Returns the total window dimensions needed for a given side layout.
function computeWindowDimsForSide(side: BubbleSide, scale: number): { width: number; height: number } {
  const spriteW = Math.round(192 * scale);
  const spriteH = Math.round(208 * scale);
  switch (side) {
    case "above":
    case "below":
      return { width: Math.max(spriteW, BUBBLE_AREA_WIDE), height: BUBBLE_AREA_TALL + spriteH };
    case "left":
    case "right":
      return { width: BUBBLE_AREA_WIDE + spriteW, height: Math.max(spriteH, BUBBLE_AREA_WIDE) };
    case "none":
    default:
      return { width: spriteW, height: spriteH };
  }
}

// Resizes the overlay window for a new side layout while keeping sprite center stable.
// "Sprite center" = center of the sprite element in screen coordinates.
// We compute it from the current window position + current side offset, then reposition
// so sprite center lands at the same screen coordinate after the resize.
function resizeOverlayForSide(win: BrowserWindow, side: BubbleSide, scale: number): void {
  const cur = win.getBounds();
  const oldOffset = getSpriteOffsetInWindow(currentBubbleSide, scale);
  const spriteW = Math.round(192 * scale);
  const spriteH = Math.round(208 * scale);
  // Sprite center in screen coords (using OLD layout offset)
  const spriteCenterX = cur.x + oldOffset.x + spriteW / 2;
  const spriteCenterY = cur.y + oldOffset.y + spriteH / 2;

  const { width, height } = computeWindowDimsForSide(side, scale);
  const newOffset = getSpriteOffsetInWindow(side, scale);
  // Reposition window so sprite center stays at same screen coord
  const newX = Math.round(spriteCenterX - newOffset.x - spriteW / 2);
  const newY = Math.round(spriteCenterY - newOffset.y - spriteH / 2);

  currentBubbleSide = side;
  console.log(`[main] resizeOverlayForSide side=${side} → ${width}×${height} at (${newX},${newY})`);
  win.setBounds({ x: newX, y: newY, width, height });
}


// State queue is instantiated here so server and IPC can share it.
// Initial subscriber forwards all args to the renderer including Phase 12C session metadata.
const queue = new StateQueue((state, agent, message, sessionId, sessionPath, sessionType) => {
  if (overlayWin && !overlayWin.isDestroyed()) {
    broadcastState(overlayWin, state, agent, message, sessionId, sessionPath, sessionType);
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

// Resize the overlay window in place when the user changes scale (Cmd+= / Cmd+-).
// Keeps the SPRITE center stable in screen coords across the resize.
// Works with any currentBubbleSide layout by reading current window dims to infer
// the old sprite center, then repositioning so sprite center is unchanged.
function resizeOverlay(win: BrowserWindow, scale: number): void {
  const cur = win.getBounds();
  const side = currentBubbleSide;

  // Derive old sprite center from current window bounds + side layout geometry.
  // We don't need the old scale — just read the areas from the fixed constants.
  let oldSpriteCenterX: number;
  let oldSpriteCenterY: number;
  switch (side) {
    case "none":
      oldSpriteCenterX = cur.x + cur.width / 2;
      oldSpriteCenterY = cur.y + cur.height / 2;
      break;
    case "above":
      oldSpriteCenterX = cur.x + cur.width / 2;
      oldSpriteCenterY = cur.y + BUBBLE_AREA_TALL + (cur.height - BUBBLE_AREA_TALL) / 2;
      break;
    case "below":
      oldSpriteCenterX = cur.x + cur.width / 2;
      oldSpriteCenterY = cur.y + (cur.height - BUBBLE_AREA_TALL) / 2;
      break;
    case "left":
      oldSpriteCenterX = cur.x + BUBBLE_AREA_WIDE + (cur.width - BUBBLE_AREA_WIDE) / 2;
      oldSpriteCenterY = cur.y + cur.height / 2;
      break;
    case "right":
    default:
      oldSpriteCenterX = cur.x + (cur.width - BUBBLE_AREA_WIDE) / 2;
      oldSpriteCenterY = cur.y + cur.height / 2;
      break;
  }

  const spriteW = Math.round(192 * scale);
  const spriteH = Math.round(208 * scale);
  const { width, height } = computeWindowDimsForSide(side, scale);
  const newOffset = getSpriteOffsetInWindow(side, scale);

  // Reposition so sprite center stays at same screen coord
  const newX = Math.round(oldSpriteCenterX - newOffset.x - spriteW / 2);
  const newY = Math.round(oldSpriteCenterY - newOffset.y - spriteH / 2);
  win.setBounds({ x: newX, y: newY, width, height });
}

function createOverlayWindow(): BrowserWindow {
  // Start sprite-only (no bubble area). Window expands dynamically when bubbles spawn.
  const cursor = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursor);
  const scale = scaleForDisplay(String(display.id));
  const { width: initW, height: initH } = computeWindowDimsForSide("none", scale);
  const win = new BrowserWindow({
    width: initW,
    height: initH,
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
  // Only state + agent matter for wander; the rest are ignored via _ prefixes.
  const unsubscribe = queue.subscribe((state, agent, _message, _sessionId, _sessionPath, _sessionType) => wanderHandle?.notifyStateChange(state, agent));
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

  // Auto-updater: only active in packaged builds. In dev (npm start) app.isPackaged
  // is false, so this block is a complete no-op — no network calls, no dialogs.
  if (app.isPackaged) {
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;

    autoUpdater.on("update-available", (info) => {
      console.log(`[updater] update available: ${info.version}`);
      new Notification({
        title: "Desktop Ash update available",
        body: `Version ${info.version} is downloading in the background.`,
      }).show();
    });

    autoUpdater.on("update-downloaded", (info) => {
      console.log(`[updater] update downloaded: ${info.version}`);
      dialog.showMessageBox({
        type: "info",
        title: "Update ready",
        message: `Desktop Ash ${info.version} is ready to install.`,
        buttons: ["Restart now", "Later"],
        defaultId: 0,
      }).then(({ response }) => {
        if (response === 0) {
          autoUpdater.quitAndInstall();
        }
      }).catch((err) => {
        console.log(`[updater] dialog error: ${err instanceof Error ? err.message : String(err)}`);
      });
    });

    autoUpdater.on("error", (err) => {
      console.log(`[updater] error: ${err instanceof Error ? err.message : String(err)}`);
    });

    // Check once on launch; electron-updater handles the GitHub Releases polling.
    autoUpdater.checkForUpdatesAndNotify().catch((err) => {
      console.log(`[updater] checkForUpdatesAndNotify error: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  // Log every state push — agent and hasMessage only, never the message body.
  queue.subscribe((state, agent, message) => {
    logActivity("state_push", { state, agent, hasMessage: message !== null && message.length > 0 });
  }); // session metadata not needed here

  // Phase 12A — outbound webhook mirror. Fires on every state transition when enabled.
  // Error states satisfy both stateChanges and errors filters simultaneously.
  queue.subscribe((state, agent, message) => {
    const cfg = loadConfig();
    const wh = cfg.webhookOutbound;
    if (!wh?.enabled) return;

    const isError = state === "failed";

    if (wh.eventFilter.stateChanges || (isError && wh.eventFilter.errors)) {
      dispatchWebhook(
        {
          event: isError ? "error" : "state_change",
          state,
          agent,
          message,
          timestamp: Date.now(),
        },
        cfg,
      );
    }
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

  // BUBBLE_LAYOUT_REQUEST: renderer invokes when first bubble of an empty stack spawns.
  // Main computes the optimal side based on screen clearance, resizes the window to
  // accommodate the bubble area, and returns the chosen side string to the renderer.
  ipcMain.handle(IPC.BUBBLE_LAYOUT_REQUEST, (_event, _payload: { count: number }) => {
    if (!overlayWin || overlayWin.isDestroyed()) return "above";

    const win = overlayWin;
    const bounds = win.getBounds();
    const display = screen.getDisplayMatching(bounds);
    const wa = display.workArea;
    const id = String(display.id);
    const scale = scaleForDisplay(id);

    // Sprite center in screen coords (using current "none" layout — window IS the sprite)
    const spriteCenterX = bounds.x + bounds.width / 2;
    const spriteCenterY = bounds.y + bounds.height / 2;

    const spriteHalfH = Math.round(208 * scale) / 2;
    const spriteHalfW = Math.round(192 * scale) / 2;

    // Clearance from sprite center to each work-area edge
    const roomAbove  = spriteCenterY - spriteHalfH - wa.y;
    const roomBelow  = (wa.y + wa.height) - (spriteCenterY + spriteHalfH);
    const roomLeft   = spriteCenterX - spriteHalfW - wa.x;
    const roomRight  = (wa.x + wa.width) - (spriteCenterX + spriteHalfW);

    // Pick side: above by default (280+20px margin), then right, left, below as fallbacks
    let side: BubbleSide;
    if (roomAbove >= 300) {
      side = "above";
    } else if (roomRight >= 280) {
      side = "right";
    } else if (roomLeft >= 280) {
      side = "left";
    } else {
      side = "below";
    }

    console.log(`[main] BUBBLE_LAYOUT_REQUEST clearances above=${Math.round(roomAbove)} below=${Math.round(roomBelow)} left=${Math.round(roomLeft)} right=${Math.round(roomRight)} → side=${side}`);
    resizeOverlayForSide(win, side, scale);

    // Phase 12A — bubble webhook. Message lives in the renderer so we emit current queue state.
    const bubbleCfg = loadConfig();
    if (bubbleCfg.webhookOutbound?.enabled && bubbleCfg.webhookOutbound.eventFilter.bubbles) {
      const current = queue.getCurrent();
      dispatchWebhook(
        {
          event: "bubble",
          state: current.state,
          agent: current.agent,
          message: current.message,
          timestamp: Date.now(),
        },
        bubbleCfg,
      );
    }

    return side;
  });

  // BUBBLE_LAYOUT_CLEAR: renderer fires after the last bubble fades.
  // Shrink the window back to sprite-only and reset side state.
  ipcMain.on(IPC.BUBBLE_LAYOUT_CLEAR, () => {
    if (!overlayWin || overlayWin.isDestroyed()) return;
    const win = overlayWin;
    const id = String(screen.getDisplayMatching(win.getBounds()).id);
    const scale = scaleForDisplay(id);
    console.log("[main] BUBBLE_LAYOUT_CLEAR → shrinking to sprite-only");
    resizeOverlayForSide(win, "none", scale);
  });

  // Extracted helper: focus the terminal where Claude Code is likely running.
  // Used as Tier 1 fallback when no sessionPath is available for direct file open.
  function focusClaudeCodeTerminal(): void {
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
    exec(`osascript -e '${script.replace(/'/g, "'\\''")}' `, (err: Error | null) => {
      if (err) console.log(`[bubble] osascript iTerm2/Terminal: ${err.message}`);
    });
  }

    // BUBBLE_CLICK: renderer left-clicked a bubble → open agent session (Tier 2) or focus app (Tier 1).
  // Phase 12C: if sessionPath is present, shell.openPath targets the exact session JSONL.
  // Falls back gracefully when session metadata is absent. Never throws — fire-and-forget.
  ipcMain.on(IPC.BUBBLE_CLICK, (_event, payload: {
    agent: string;
    sessionType?: string;
    sessionPath?: string;
    sessionId?: string;
  }) => {
    const agent = payload?.agent ?? "";
    const sessionType = typeof payload?.sessionType === "string" ? payload.sessionType : null;
    const sessionPath = typeof payload?.sessionPath === "string" ? payload.sessionPath : null;
    const sessionId = typeof payload?.sessionId === "string" ? payload.sessionId : null;
    console.log(`[bubble] click → agent="${agent}" sessionType=${sessionType ?? "none"} sessionId=${sessionId ?? "none"}`);

    if (agent === "claude-code") {
      if (sessionPath) {
        // Tier 2: explicitly open the session JSONL in VS Code (Capt's preference).
        // Bypasses OS file association — uses `code` CLI directly. Falls back to terminal
        // if `code` is missing from PATH.
        const escaped = sessionPath.replace(/"/g, '\\"');
        exec(`code "${escaped}"`, (err: Error | null) => {
          if (err) {
            console.log(`[bubble] code CLI failed (${err.message}) → falling back to terminal`);
            focusClaudeCodeTerminal();
            logActivity("bubble_click", { agent, sessionType, sessionId, action: "terminal_fallback", reason: err.message });
          } else {
            logActivity("bubble_click", { agent, sessionType, sessionId, action: "open_in_vscode" });
          }
        });
      } else {
        // Tier 1 fallback: no session path — just focus the terminal running Claude Code.
        focusClaudeCodeTerminal();
        logActivity("bubble_click", { agent, sessionType, sessionId, action: "terminal_focus" });
      }
    } else if (agent === "codex") {
      // Capt uses Codex.app for Codex sessions. No URL scheme for sessions exists,
      // so we focus the app and let the user navigate from there.
      exec(`osascript -e 'tell application "Codex" to activate' 2>/dev/null || osascript -e 'tell application "ChatGPT" to activate'`, (err: Error | null) => {
        if (err) console.log(`[bubble] osascript Codex/ChatGPT: ${err.message}`);
        logActivity("bubble_click", { agent, sessionType, sessionId, action: "focus_codex_app" });
      });
    } else if (agent === "gemini") {
      // Capt uses the Gemini app for Gemini sessions. Same focus-app pattern as Codex.
      exec(`osascript -e 'tell application "Gemini" to activate'`, (err: Error | null) => {
        if (err) console.log(`[bubble] osascript Gemini: ${err.message}`);
        logActivity("bubble_click", { agent, sessionType, sessionId, action: "focus_gemini_app" });
      });
    } else {
      console.log(`[bubble] no app target for agent "${agent}" — no-op`);
      logActivity("bubble_click", { agent, sessionType, sessionId, action: "noop" });
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
