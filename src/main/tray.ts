import { app, Tray, Menu, nativeImage, screen, BrowserWindow } from "electron";
import path from "path";
import type { WanderHandle } from "./wander.js";

// Module-level reference keeps the tray from being GC'd after startTray() returns.
let tray: Tray | null = null;

interface TrayDeps {
  overlayWin: () => BrowserWindow | null;
  wanderHandle: () => WanderHandle | null;
  openSettings: () => void;
  openPicker: () => void;
}

// Rebuild and re-assign the context menu each time it needs to reflect updated state.
// Called on first build and each time a toggle fires so labels stay in sync.
function buildMenu(deps: TrayDeps): Electron.Menu {
  const win = deps.overlayWin();
  const handle = deps.wanderHandle();

  const visible = win && !win.isDestroyed() ? win.isVisible() : true;
  const wanderPaused = handle ? handle.isPaused() : false;
  const openAtLogin = app.getLoginItemSettings().openAtLogin;

  return Menu.buildFromTemplate([
    {
      label: visible ? "Hide Ash" : "Show Ash",
      click() {
        const w = deps.overlayWin();
        if (!w || w.isDestroyed()) return;
        if (w.isVisible()) {
          w.hide();
        } else {
          w.show();
          w.focus();
        }
        refreshMenu(deps);
      },
    },
    {
      label: "Recenter",
      click() {
        const w = deps.overlayWin();
        if (!w || w.isDestroyed()) return;
        recenterOverlay(w);
      },
    },
    {
      label: wanderPaused ? "Resume Wander" : "Pause Wander",
      click() {
        const h = deps.wanderHandle();
        if (!h) return;
        if (h.isPaused()) {
          h.resume();
        } else {
          h.pause();
        }
        refreshMenu(deps);
      },
    },
    { type: "separator" },
    {
      label: "Change Pet...",
      click() {
        deps.openPicker();
      },
    },
    {
      label: "Settings...",
      click() {
        deps.openSettings();
      },
    },
    { type: "separator" },
    {
      label: "Open at Login",
      type: "checkbox",
      checked: openAtLogin,
      click(menuItem) {
        app.setLoginItemSettings({ openAtLogin: menuItem.checked, openAsHidden: false });
        refreshMenu(deps);
      },
    },
    { type: "separator" },
    {
      label: "Quit Desktop Ash",
      click() {
        app.quit();
      },
    },
  ]);
}

function refreshMenu(deps: TrayDeps): void {
  if (!tray || tray.isDestroyed()) return;
  tray.setContextMenu(buildMenu(deps));
}

// Recenter the overlay on whichever display the overlay window currently lives on.
// Uses the display the window is already on (not cursor position) — more predictable:
// user may have moved cursor to a different monitor while dragging the window.
// Sprite center lands at work-area center; window top-left is offset upward by
// BUBBLE_AREA_HEIGHT so the sprite itself is visually centered, not the full window.
function recenterOverlay(win: BrowserWindow): void {
  if (win.isDestroyed()) return;
  const BUBBLE_AREA_HEIGHT = 280;
  const display = screen.getDisplayMatching(win.getBounds());
  const wa = display.workArea;
  const b = win.getBounds();

  // Sprite center at work-area center
  const spriteCenterX = wa.x + wa.width / 2;
  const spriteCenterY = wa.y + wa.height / 2;
  const spriteH = b.height - BUBBLE_AREA_HEIGHT;

  win.setBounds({
    x: Math.round(spriteCenterX - b.width / 2),
    y: Math.round(spriteCenterY - BUBBLE_AREA_HEIGHT - spriteH / 2),
    width: b.width,
    height: b.height,
  });
  console.log(`[tray] recenter → display ${display.id} work-area center (${spriteCenterX},${spriteCenterY})`);
}

export function startTray(deps: TrayDeps): void {
  const iconPath = path.join(app.getAppPath(), "assets", "tray-icon-Template.png");
  const icon = nativeImage.createFromPath(iconPath);

  if (icon.isEmpty()) {
    // Log clearly so a missing-asset bug is immediately visible in logs.
    console.error(`[tray] icon not found at ${iconPath} — tray will render empty`);
  }

  tray = new Tray(icon);
  tray.setToolTip("Desktop Ash");

  const menu = buildMenu(deps);
  tray.setContextMenu(menu);

  // On macOS both left-click and right-click open the context menu by default
  // when setContextMenu is used. This is the standard behavior. No explicit
  // click handler needed — the menu pops up on either button press.

  console.log("[tray] created");
}

// Exported so main.ts can trigger a menu refresh (e.g. after overlay show/hide
// state changes from sources other than the tray itself).
export function refreshTrayMenu(deps: TrayDeps): void {
  refreshMenu(deps);
}
