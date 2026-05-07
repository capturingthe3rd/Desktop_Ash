#!/bin/bash
# Builds an AppleScript-wrapper .app that launches the dev electron command.
# Use this when you don't have a properly signed .dmg yet (Phase 11C scaffolding
# requires Apple Developer secrets in GitHub Actions to produce a signed build).
#
# Why an AppleScript wrapper instead of the electron-builder .app?
#   - macOS 26+ Gatekeeper silently rejects unsigned/ad-hoc-signed apps in /Applications.
#   - AppleScript .apps built via osacompile are auto-signed by macOS with the local
#     identity and pass Gatekeeper for the user's session.
#
# Usage:
#   ./scripts/build-launcher.sh              # installs to /Applications
#   ./scripts/build-launcher.sh ~/Desktop    # installs to a custom dir

set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ELECTRON_BIN="$REPO_DIR/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
INSTALL_DIR="${1:-/Applications}"
APP_PATH="$INSTALL_DIR/Desktop Ash.app"

if [ ! -x "$ELECTRON_BIN" ]; then
  echo "ERROR: Electron binary not found at $ELECTRON_BIN" >&2
  echo "Run 'npm install' first." >&2
  exit 1
fi

# AppleScript: unset ELECTRON_RUN_AS_NODE (some envs leak it and break Electron),
# cd into repo, launch real Electron.app binary detached (& disown), redirect logs.
SCRIPT="do shell script \"unset ELECTRON_RUN_AS_NODE; cd $REPO_DIR && $ELECTRON_BIN . > /tmp/desktop_ash.log 2>&1 & disown\""

# Remove existing if present
[ -e "$APP_PATH" ] && rm -rf "$APP_PATH"

osacompile -o "$APP_PATH" -e "$SCRIPT"
echo "Built launcher at: $APP_PATH"
echo "Drag it to the Dock to pin."
echo "Logs while running: /tmp/desktop_ash.log"
