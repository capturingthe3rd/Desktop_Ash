# Path-based review policy for Desktop_Ash.
# Sourced by run-review.sh — exposes is_secret_bearing() and classify_file().
#
# is_secret_bearing(path) → return 0 if file likely contains real secret values
#   (env vars, private keys, credentials, tokens). These files NEVER get sent
#   to a cloud LLM API, even for review. They're listed for manual review.
#
# classify_file(path) → "<severity>|<chain>" for review-eligible files
#   severity: any-concern | critical-only | informational
#   chain:    security+code-review | code-review | code-review-light
#
# Severity reflects how strict the reviewer should be.
# Chain reflects which lens(es) to apply.
#
# Tweak this file to match how the project actually evolves.
# Rule of thumb: if you're bypassing >10% of commits, loosen severity here.

# Files that typically contain real secret values. NEVER send to cloud LLM API.
# Be conservative — false positives just route to manual review (mild friction);
# false negatives leak secrets to a third-party API (catastrophic, irreversible).
is_secret_bearing() {
  local path="$1"

  # Environment files (real secret values typically live here)
  [[ "$path" =~ (^|/)\.env($|\.|[^/]) ]] && return 0
  [[ "$path" =~ \.env$ ]] && return 0

  # Private keys, certificates, key material
  [[ "$path" =~ \.(key|pem|p12|pfx|cer|crt|asc|gpg|jks|keystore)$ ]] && return 0

  # SSH keys (no extension)
  [[ "$path" =~ (^|/)id_(rsa|ed25519|dsa|ecdsa)$ ]] && return 0

  # Cloud / CI credentials (matches at start, after path sep, or after - . _)
  [[ "$path" =~ (^|/|-|\.|_)(credentials|service[-_]account)(\.json|\.yaml|\.yml)?$ ]] && return 0
  [[ "$path" =~ (^|/)\.aws/credentials ]] && return 0
  [[ "$path" =~ (^|/)\.kube/config ]] && return 0
  [[ "$path" =~ (^|/)\.netrc$ ]] && return 0

  # Package manager auth tokens
  [[ "$path" =~ (^|/)\.npmrc$ ]] && return 0
  [[ "$path" =~ (^|/)\.pypirc$ ]] && return 0

  # Conventional secret folders
  [[ "$path" =~ (^|/)\.?secrets?/ ]] && return 0
  [[ "$path" =~ (^|/)private/ ]] && return 0

  # Cookies, session dumps
  [[ "$path" =~ (^|/)cookies?\.(txt|json)$ ]] && return 0

  return 1
}

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
