# Electron 42 + macOS 26.3 right-click crash

## Symptom

Right-clicking the transparent always-on-top overlay window causes the entire Electron process to segfault (SIGSEGV / EXC_BAD_ACCESS). Crash report written to `~/Library/Logs/DiagnosticReports/Electron-*.ips`.

## Crash signature

```
Exception Type:  EXC_BAD_ACCESS (SIGSEGV)
Exception Codes: KERN_INVALID_ADDRESS at 0x0000000000000000
Crashed Thread:  CrBrowserMain (Chromium browser main thread)

Top frames involve:
  objc_release
  OBJC_CLASS_$_NSEvent
  _updateCanQuitQuietlyAndSafely
```

The `_updateCanQuitQuietlyAndSafely` symbol is a quit-readiness check that fires whenever certain app-level NSEvents arrive. On macOS 26.3 + Electron 42, that path null-derefs because some menu/quit-related state is null.

## Affected configurations

- macOS 26.3 (build 25D2125) — verified
- Electron 42.0.0 — verified
- Window config: `transparent: true`, `frame: false`, `alwaysOnTop: true`, `setVisibleOnAllWorkspaces`, `setAlwaysOnTop("screen-saver")`

Likely affects other Electron transparent-window apps on the same macOS version.

## Workaround in place

Three layers of defense, all required (renderer-only was insufficient — second crash 2026-05-07 11:56:32 reproduced via different stack frames inside `NSApplication sendEvent:` → `_handleEvent:`, never reaching the renderer):

**Layer 1 (browser process, primary):** `webContents.on("context-menu", e => e.preventDefault())` on every BrowserWindow (overlay, picker, settings). Intercepts the right-click in the browser process before Chromium dispatches it deeper into AppKit menu construction. This is the layer that actually catches the bug — the renderer-side handlers fire too late because the crash occurs during browser-process event dispatch, before IPC to the renderer.

**Layer 2 (app menu):** `Menu.setApplicationMenu(null)` called at module top of `main.ts` (before `app.whenReady`). Removes the global NSMenu so `_updateCanQuitQuietlyAndSafely` never null-derefs.

**Layer 3 (renderer, backup):** in `renderer.ts`:
1. `mousedown` capture handler `preventDefault`s right-button events outside bubble elements
2. `contextmenu` event handler suppresses any context menu that slips through

Defense in `main.ts`:
- Drag region scoped only to the visible sprite area (not the full body)
- `close` event interceptor → window hides instead of destroying when `!isQuitting`

## Reproducibility

To verify the workaround is sufficient (or to confirm a regression):
1. Run `npm start`
2. Right-click anywhere on the visible Ash sprite
3. Expected: nothing happens (no menu, no crash)
4. If the process dies: check `~/Library/Logs/DiagnosticReports/Electron-*.ips` for the latest crash; compare top frames to this signature.

## Future action

Track Electron release notes for fixes related to:
- `NSEvent` handling in transparent windows
- `_updateCanQuitQuietlyAndSafely` null-deref
- macOS 26.x compatibility patches

Once an Electron version ships the fix, remove `Menu.setApplicationMenu(null)` and re-test. The workaround is cheap to keep, but cleaner upstream.

## Status as of 2026-05-07 (afternoon)

Workaround: ✅ in place at all 3 layers (browser-process context-menu intercept added after second crash)
Outstanding verification: Capt to right-click Ash post-fix and confirm no crash
Outstanding: filing an Electron upstream issue (deferred — low priority since workaround is stable)

## Crash signature variants observed

Both crashes have `EXC_BAD_ACCESS / KERN_INVALID_ADDRESS at 0x0` on `CrBrowserMain` thread, but the stack frame attribution differs:

- **Variant 1 (original):** `objc_release` / `OBJC_CLASS_$_NSEvent` / `_updateCanQuitQuietlyAndSafely` — addressed by `Menu.setApplicationMenu(null)`.
- **Variant 2 (2026-05-07 11:56:32):** `NSApplication sendEvent:` → `NSApplication _handleEvent:` → null-deref in symbol-stripped Electron Framework code. NOT in the menu-readiness path. Addressed by `webContents.on("context-menu")` browser-process intercept.

Both are the same root bug (Electron 42 + macOS 26.3 NSEvent handling on transparent windows) surfacing through different code paths. Either path can be hit depending on app uptime and event timing — the second crash occurred after ~2 hours of uptime.
Outstanding: filing an Electron upstream issue (deferred — low priority since workaround is stable)
