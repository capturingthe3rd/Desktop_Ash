#!/usr/bin/env bash
# Desktop Ash hook adapter for Claude Code.
# Translates Claude Code hook events → state pushes to http://127.0.0.1:7878/state.
#
# Fire-and-forget: --max-time 0.5 + backgrounded with & so this script NEVER blocks
# Claude Code. Exit 0 unconditionally — a nonzero exit would abort tool calls.
#
# Companion to https://github.com/capturingthe3rd/Desktop_Ash. Canonical copy of
# this file lives in the repo at scripts/claude-hooks/desktop_ash.sh; install at
# ~/.claude/hooks/desktop_ash.sh and wire into ~/.claude/settings.json.

ASH_URL="http://127.0.0.1:7878/state"
AGENT="claude-code"
THROTTLE_FILE="${TMPDIR:-/tmp}/ash-hook-last-push"
THROTTLE_MS=1500   # don't fire two non-completion pushes within this many ms

# Read stdin once. If Desktop Ash isn't running we still need a clean exit.
HOOK_JSON=$(cat)

# zsh's `echo` reinterprets backslash escapes — printf '%s' is byte-faithful.
# Always pipe HOOK_JSON to jq via printf, never echo.
HOOK_EVENT=$(printf '%s' "$HOOK_JSON" | jq -r '.hook_event_name // ""' 2>/dev/null)
TOOL_NAME=$(printf '%s' "$HOOK_JSON" | jq -r '.tool_name // ""' 2>/dev/null)

# python3 fallback if jq unavailable for some reason.
if [ -z "$HOOK_EVENT" ] && command -v python3 &>/dev/null; then
  HOOK_EVENT=$(printf '%s' "$HOOK_JSON" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('hook_event_name',''))" 2>/dev/null)
  TOOL_NAME=$(printf '%s' "$HOOK_JSON" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('tool_name',''))" 2>/dev/null)
fi

[ -z "$HOOK_EVENT" ] && exit 0

# ── Throttle helper ────────────────────────────────────────────────────────────
# Stops Ash from flickering between states when many tool calls fire in rapid
# succession. Only applies to non-completion events (PreToolUse / UserPromptSubmit
# / SessionStart). Stop and PostToolUse-error always fire.
now_ms() {
  python3 -c "import time; print(int(time.time()*1000))" 2>/dev/null || date +%s000
}

should_throttle() {
  local now last delta
  now=$(now_ms)
  if [ -f "$THROTTLE_FILE" ]; then
    last=$(cat "$THROTTLE_FILE" 2>/dev/null)
    if [ -n "$last" ]; then
      delta=$((now - last))
      [ "$delta" -lt "$THROTTLE_MS" ] && return 0  # too soon
    fi
  fi
  echo "$now" > "$THROTTLE_FILE" 2>/dev/null
  return 1  # not throttled
}

# ── Push helper ────────────────────────────────────────────────────────────────
# Optional 3rd arg = bubble message (only set on completion events).
push_state() {
  local state="$1"
  local ttl="$2"
  local message="${3:-}"
  local payload
  if [ -n "$message" ]; then
    local escaped
    escaped=$(printf '%s' "$message" | python3 -c "import sys,json; print(json.dumps(sys.stdin.read().strip())[1:-1])" 2>/dev/null)
    payload="{\"state\":\"${state}\",\"ttlMs\":${ttl},\"agent\":\"${AGENT}\",\"priority\":0,\"message\":\"${escaped}\"}"
  else
    payload="{\"state\":\"${state}\",\"ttlMs\":${ttl},\"agent\":\"${AGENT}\",\"priority\":0}"
  fi
  curl -s -X POST "$ASH_URL" \
    -H "content-type: application/json" \
    -d "$payload" \
    --max-time 0.5 \
    -o /dev/null 2>/dev/null &
}

# ── Hook → state mapping ───────────────────────────────────────────────────────
case "$HOOK_EVENT" in

  SessionStart)
    push_state "waving" 1500
    ;;

  UserPromptSubmit)
    # User submitted a prompt → model is about to think. Show "waiting" so Ash
    # visibly anticipates rather than staying idle until the first tool call.
    should_throttle && exit 0
    push_state "waiting" 4000
    ;;

  PreToolUse)
    # Throttle so a long sequence of tool calls doesn't flicker Ash between
    # running and review on every hook fire. The first tool of a turn sets the
    # state; subsequent quick-fire tools coast on the existing TTL.
    should_throttle && exit 0
    case "$TOOL_NAME" in
      Read|Grep|Glob|LS|mcp__*__*)
        push_state "review" 3000
        ;;
      Bash|Edit|Write|MultiEdit|NotebookEdit)
        push_state "running" 3000
        ;;
      *)
        push_state "running" 3000
        ;;
    esac
    ;;

  PostToolUse)
    # Use signal-based error detection first (Claude Code provides
    # tool_response.is_error in newer versions), fall back to text patterns
    # that work anywhere in the output (not just line start).
    HAS_ERROR=0
    IS_ERROR_FIELD=$(printf '%s' "$HOOK_JSON" | jq -r '.tool_response.is_error // .tool_error // empty' 2>/dev/null)
    if [ "$IS_ERROR_FIELD" = "true" ]; then
      HAS_ERROR=1
    fi

    if [ "$HAS_ERROR" -eq 0 ]; then
      # Best-effort text scan — match anywhere in the output, not just line start.
      TOOL_RESULT=$(printf '%s' "$HOOK_JSON" | jq -r '(.tool_response.content // .tool_response // .tool_result // "") | tostring' 2>/dev/null)
      if [ -n "$TOOL_RESULT" ]; then
        printf '%s' "$TOOL_RESULT" | grep -qiE '\b(command not found|no such file|permission denied|ENOENT|EACCES|EPERM)\b' 2>/dev/null && HAS_ERROR=1
      fi
    fi

    [ "$HAS_ERROR" -eq 1 ] && push_state "failed" 2500
    # Success: no push, let prior PreToolUse TTL decay to idle naturally.
    ;;

  Stop)
    # Bubble message: read last_assistant_message from stdin (this is the field
    # Claude Code actually provides; previous code tried transcript_path/jq
    # which works as fallback but the direct field is simpler and faster).
    LAST_MSG=$(printf '%s' "$HOOK_JSON" | jq -r '.last_assistant_message // ""' 2>/dev/null)
    [ "$LAST_MSG" = "null" ] && LAST_MSG=""

    # Fallback: walk transcript_path JSONL for the last assistant entry.
    if [ -z "$LAST_MSG" ]; then
      TRANSCRIPT_PATH=$(printf '%s' "$HOOK_JSON" | jq -r '.transcript_path // ""' 2>/dev/null)
      if [ -n "$TRANSCRIPT_PATH" ] && [ -f "$TRANSCRIPT_PATH" ]; then
        LAST_MSG=$(jq -rs '
          map(select(.type=="assistant" or .role=="assistant")) | last
          | (.message.content // .content // [])
          | (if type=="array" then map(select(.type=="text") | .text) | join(" ") else . end)
        ' "$TRANSCRIPT_PATH" 2>/dev/null)
      fi
    fi
    [ "$LAST_MSG" = "null" ] && LAST_MSG=""

    push_state "jumping" 1500 "$LAST_MSG"
    ;;

  SubagentStop)
    # A delegated subagent finished; lighter celebration than main Stop.
    push_state "jumping" 1000
    ;;

esac

# Always exit 0 — never block Claude Code on hook failure.
exit 0
