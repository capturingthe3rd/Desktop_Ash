#!/usr/bin/env bash
# Synthetic Codex bridge test.
# Writes crafted JSONL events to a fake session file and confirms Desktop Ash
# receives the correct state pushes via POST /state.
#
# Prerequisites:
#   1. Desktop Ash is running with codexBridgeEnabled: true in config.json
#   2. Run this script: bash scripts/test-codex-bridge.sh

set -euo pipefail

BASE="http://127.0.0.1:7878"
YEAR=$(date +%Y)
DATE=$(date +%Y-%m-%d)
SESSION_DIR="$HOME/.codex/sessions/$YEAR/$DATE"
FAKE_FILE="$SESSION_DIR/rollout-$(date -u +%Y-%m-%dT%H-%M-%S)-00000000-0000-0000-0000-000000000000.jsonl"

echo "=== Codex Bridge Synthetic Test ==="
echo ""
echo "Session dir : $SESSION_DIR"
echo "Fake file   : $FAKE_FILE"
echo "Ash server  : $BASE"
echo ""

# Confirm Desktop Ash server is up
echo -n "[0] GET /state (server health check) ... "
curl -fsS "$BASE/state" > /dev/null
echo "OK"
echo ""

mkdir -p "$SESSION_DIR"

append_event() {
  local label="$1"
  local json="$2"
  echo "  → appending: $label"
  echo "$json" >> "$FAKE_FILE"
  sleep 0.4   # allow chokidar to fire + debounce to flush
}

get_state() {
  curl -sS "$BASE/state" | python3 -c "import sys,json; d=json.load(sys.stdin); print(f\"state={d['state']} agent={d['agent']}\")"
}

echo "[1] session_meta → expect waving"
append_event "session_meta" '{"timestamp":"2026-01-01T00:00:00.000Z","type":"session_meta","payload":{"id":"test-session","timestamp":"2026-01-01T00:00:00.000Z","cwd":"/tmp","originator":"Codex Desktop","cli_version":"0.0.0-test","source":"vscode","model_provider":"openai","base_instructions":{"text":"test"}}}'
sleep 0.5
echo -n "  GET /state: "; get_state; echo ""

echo "[2] task_started → expect waiting"
append_event "task_started" '{"timestamp":"2026-01-01T00:00:01.000Z","type":"event_msg","payload":{"type":"task_started","turn_id":"turn-001","started_at":1000,"model_context_window":128000,"collaboration_mode_kind":"default"}}'
sleep 0.5
echo -n "  GET /state: "; get_state; echo ""

echo "[3] function_call → expect running"
append_event "function_call" '{"timestamp":"2026-01-01T00:00:02.000Z","type":"response_item","payload":{"type":"function_call","name":"exec_command","arguments":"{\"cmd\":\"echo hello\"}","call_id":"call-001"}}'
sleep 0.5
echo -n "  GET /state: "; get_state; echo ""

echo "[4] function_call_output (exit code 1) → expect failed"
append_event "function_call_output_fail" '{"timestamp":"2026-01-01T00:00:03.000Z","type":"response_item","payload":{"type":"function_call_output","call_id":"call-001","output":"Chunk ID: abc\nWall time: 0.1 seconds\nProcess exited with code 1\nOutput:\nsome error"}}'
sleep 0.5
echo -n "  GET /state: "; get_state; echo ""

echo "[5] task_complete → expect jumping"
append_event "task_complete" '{"timestamp":"2026-01-01T00:00:04.000Z","type":"event_msg","payload":{"type":"task_complete","turn_id":"turn-001","last_agent_message":"Done.","completed_at":1004,"duration_ms":4000,"time_to_first_token_ms":500}}'
sleep 0.5
echo -n "  GET /state: "; get_state; echo ""

echo "[6] error event → expect failed"
append_event "error" '{"timestamp":"2026-01-01T00:00:05.000Z","type":"event_msg","payload":{"type":"error","message":"Test error","codex_error_info":"usage_limit_exceeded"}}'
sleep 0.5
echo -n "  GET /state: "; get_state; echo ""

echo ""
echo "Cleaning up fake session file..."
rm -f "$FAKE_FILE"
echo "Done. If all states matched above, the Codex bridge is working."
