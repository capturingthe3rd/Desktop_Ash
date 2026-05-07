# Path-based review policy for Desktop_Ash.
# Sourced by run-review.sh — exposes classify_file().
#
# Classification → "<severity>|<chain>"
#   severity: any-concern | critical-only | informational
#   chain:    security+code-review | code-review | code-review-light
#
# Severity reflects how strict the reviewer should be.
# Chain reflects which lens(es) to apply.
#
# Tweak this file to match how the project actually evolves.
# Rule of thumb: if you're bypassing >10% of commits, loosen severity here.

classify_file() {
  local path="$1"

  # Security-sensitive paths — block on any concern, layered review.
  # NOTE: bare "key" excluded on purpose to avoid matching keyboard.ts, keymap.ts, etc.
  # Add more terms here when the project grows real auth surface.
  if [[ "$path" =~ (auth|secret|token|credential|api-key) ]] \
     || [[ "$path" =~ ^\.env ]] \
     || [[ "$path" =~ \.env$ ]] \
     || [[ "$path" =~ \.env\. ]]; then
    echo "any-concern|security+code-review"
    return
  fi

  # Tests — informational only. Test files don't ship to users.
  if [[ "$path" =~ \.(test|spec)\.(ts|tsx|js|jsx)$ ]] \
     || [[ "$path" =~ ^(tests?|__tests__)/ ]] \
     || [[ "$path" =~ /(tests?|__tests__)/ ]]; then
    echo "informational|code-review-light"
    return
  fi

  # Docs and markdown — informational only.
  if [[ "$path" =~ \.md$ ]] \
     || [[ "$path" =~ ^(docs|README) ]] \
     || [[ "$path" =~ /docs/ ]]; then
    echo "informational|code-review-light"
    return
  fi

  # Production source — block only on critical issues.
  if [[ "$path" =~ ^(src|electron)/.+\.(ts|tsx|js|jsx)$ ]]; then
    echo "critical-only|code-review"
    return
  fi

  # Everything else (config, scripts, build files) — informational.
  echo "informational|code-review"
}
