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

`Menu.setApplicationMenu(null)` called early in `main.ts` (before `app.whenReady`). Removing the global application menu changes the NSEvent dispatch path so `_updateCanQuitQuietlyAndSafely` never fires for right-click events. Cost is zero — Desktop Ash uses a tray for all user actions, no app menu needed.

Additional defenses in `renderer.ts`:
1. `mousedown` capture handler `preventDefault`s right-button events outside bubble elements
2. `contextmenu` event handler suppresses Chromium's browser context menu

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

## Status as of 2026-05-07

Workaround: ✅ in place, in production
Verified by: Capt confirmed earlier session no crashes after `Menu.setApplicationMenu(null)` deployed
Outstanding: filing an Electron upstream issue (deferred — low priority since workaround is stable)
