#!/usr/bin/env bash
# Summarize last N sessions from the activity log.
# Usage: log-summary.sh [N]   (default N=5)
# Requires: jq (brew install jq)
set -euo pipefail

N="${1:-5}"
LOGS="$HOME/Library/Application Support/Desktop_Ash/logs/activity.jsonl"

if [[ ! -f "$LOGS" ]]; then
  echo "Activity log not found at: $LOGS"
  echo "Start Desktop Ash first."
  exit 1
fi

# Parse all lines into an array of objects, group by session_id, then summarise.
# Sessions are ordered by their first launch event ts (most recent N sessions shown).
jq -rn --argjson n "$N" '
  # Read all lines into an array, skip blank lines
  [inputs | select(length > 0)] as $lines |

  # Group entries by session_id
  ( $lines | group_by(.session_id) ) as $sessions |

  # For each session collect stats
  [ $sessions[] |
    . as $entries |
    {
      session_id: $entries[0].session_id,
      launch_ts:  ( $entries[] | select(.type == "launch") | .ts ) // $entries[0].ts,
      exit_reason: (
        if any(.[]; .type == "shutdown_clean") then "clean"
        elif any(.[]; .type == "crash_detected") then "crash_detected_prev"
        else "unknown (still running?)"
        end
      ),
      duration_s: (
        ( $entries[-1].ts | gsub("\\.[0-9]+Z$"; "Z") | fromdateiso8601 ) -
        ( $entries[0].ts  | gsub("\\.[0-9]+Z$"; "Z") | fromdateiso8601 )
      ),
      event_counts: ( $entries | group_by(.type) | map({ key: .[0].type, value: length }) | from_entries )
    }
  ] |

  # Sort by launch_ts descending, take last N
  sort_by(.launch_ts) | reverse | .[:$n] | reverse |

  # Pretty-print each session
  .[] |
  "─────────────────────────────────────────────",
  "Session : \(.session_id)",
  "Launch  : \(.launch_ts)",
  "Duration: \(.duration_s)s",
  "Exit    : \(.exit_reason)",
  "Events  : \(.event_counts | to_entries | map("\(.key)=\(.value)") | join("  "))",
  ""
' "$LOGS"
