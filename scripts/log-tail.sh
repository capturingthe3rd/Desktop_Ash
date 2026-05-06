#!/usr/bin/env bash
# Live-tail the activity log with friendly per-line formatting.
# Requires: jq (brew install jq)
LOGS="$HOME/Library/Application Support/Desktop_Ash/logs/activity.jsonl"

if [[ ! -f "$LOGS" ]]; then
  echo "Activity log not found at: $LOGS"
  echo "Start Desktop Ash first."
  exit 1
fi

tail -f "$LOGS" | jq -r '"\(.ts | sub("T"; " ") | sub("\\..*Z$"; "")) [\(.type)] \(.data | tostring)"'
