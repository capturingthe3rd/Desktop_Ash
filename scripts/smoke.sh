#!/usr/bin/env bash
# Manual smoke test — cycles all 9 states against the running Desktop Ash server.
# Usage: start the app first with `npm start`, then run `bash scripts/smoke.sh`.
# Note: if launched from Claude Code terminal, npm start clears ELECTRON_RUN_AS_NODE automatically.

BASE="http://127.0.0.1:7878"
DELAY=4  # seconds between state pushes (give TTL time to show, not expire)

set -euo pipefail

echo "=== Desktop Ash Smoke Test ==="
echo "Base: $BASE"
echo ""

push_state() {
  local state="$1"
  local label="${2:-$state}"
  echo -n "→ $label ... "
  curl -sS -X POST "$BASE/state" \
    -H "content-type: application/json" \
    -d "{\"state\":\"$state\",\"agent\":\"smoke-test\",\"ttlMs\":3500}"
  echo ""
  sleep 0.3
  echo -n "  GET /state: "
  curl -sS "$BASE/state"
  echo ""
  sleep $DELAY
}

echo "[1/10] running-right"
push_state "running-right"

echo "[2/10] running-left"
push_state "running-left"

echo "[3/10] waving"
push_state "waving"

echo "[4/10] jumping"
push_state "jumping"

echo "[5/10] failed"
push_state "failed"

echo "[6/10] waiting"
push_state "waiting"

echo "[7/10] running"
push_state "running"

echo "[8/10] review"
push_state "review"

echo "[9/10] idle (sticky)"
curl -sS -X POST "$BASE/state" \
  -H "content-type: application/json" \
  -d '{"state":"idle","agent":"smoke-test"}'
echo ""

echo ""
echo "[10/10] Invalid state — expect 400"
curl -sS -X POST "$BASE/state" \
  -H "content-type: application/json" \
  -d '{"state":"bogus"}' || true
echo ""

echo ""
echo "=== Smoke test complete ==="
