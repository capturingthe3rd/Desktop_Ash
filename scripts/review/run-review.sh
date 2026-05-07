#!/usr/bin/env bash
# Pre-commit autonomous reviewer for Desktop_Ash.
# Reads staged files, classifies them via policy.sh, calls Claude headless,
# exits 0 (allow commit) or 1 (block commit).
#
# Bypass with: git commit --no-verify
# Skip review only (still commit) with: SKIP_REVIEW=1 git commit ...

set -euo pipefail

# Skip switch — useful for WIP commits without disabling the hook entirely.
if [[ "${SKIP_REVIEW:-0}" == "1" ]]; then
  echo "[review] SKIP_REVIEW=1, skipping"
  exit 0
fi

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

# shellcheck source=./policy.sh
source "$REPO_ROOT/scripts/review/policy.sh"

STAGED=()
while IFS= read -r line; do
  [[ -n "$line" ]] && STAGED+=("$line")
done < <(git diff --cached --name-only --diff-filter=ACMR)

if [[ ${#STAGED[@]} -eq 0 ]]; then
  echo "[review] no staged changes, skipping"
  exit 0
fi

# Determine the strictest severity across changed files.
# Order: any-concern > critical-only > informational.
TIGHTEST_SEVERITY="informational"
NEEDS_SECURITY_CHAIN=0

for f in "${STAGED[@]}"; do
  classification=$(classify_file "$f")
  severity="${classification%%|*}"
  chain="${classification##*|}"

  case "$severity" in
    any-concern)
      TIGHTEST_SEVERITY="any-concern" ;;
    critical-only)
      [[ "$TIGHTEST_SEVERITY" != "any-concern" ]] && TIGHTEST_SEVERITY="critical-only" ;;
  esac

  [[ "$chain" == "security+code-review" ]] && NEEDS_SECURITY_CHAIN=1
done

echo "[review] ${#STAGED[@]} staged file(s), severity=$TIGHTEST_SEVERITY"

# Build the prompt: instructions + diffs + full file context.
PROMPT_FILE=$(mktemp -t ds-review.XXXXXX)
trap 'rm -f "$PROMPT_FILE"' EXIT

{
  echo "You are reviewing a pre-commit diff for the Desktop_Ash project (TypeScript/Electron pet overlay)."
  echo ""
  echo "## Review policy"
  echo "Severity for this commit: $TIGHTEST_SEVERITY"
  echo ""
  case "$TIGHTEST_SEVERITY" in
    any-concern)
      echo "Block this commit if you find ANY concern: bug, smell, ambiguity, missing test, sketchy security pattern, anything noteworthy."
      ;;
    critical-only)
      echo "Block this commit ONLY if you find a CRITICAL issue: data loss risk, obvious runtime bug, security vulnerability, broken type contract, dependency that won't resolve at runtime, or change that breaks an existing feature."
      echo "Style nits, naming preferences, refactor suggestions, missing tests — all FYI only, do not block."
      ;;
    informational)
      echo "Do NOT block this commit. Only provide notes if something is worth flagging. Always end with VERDICT: PASS."
      ;;
  esac
  echo ""

  if [[ $NEEDS_SECURITY_CHAIN -eq 1 ]]; then
    echo "## Security focus"
    echo "At least one staged file matches a security-sensitive pattern (auth/secret/token/credential/.env)."
    echo "Apply STRIDE thinking: Spoofing, Tampering, Repudiation, Information disclosure, DoS, Elevation of privilege."
    echo "Flag any: hardcoded credentials, logging of secrets, missing input validation, broken authz checks, weak crypto."
    echo ""
  fi

  echo "## Output format (mandatory)"
  echo "1. One-line summary of what changed."
  echo "2. Findings ordered by severity tag: [Critical] / [High] / [Medium] / [Low] / [Info]."
  echo "3. Final line MUST be exactly one of:  VERDICT: PASS  or  VERDICT: BLOCK"
  echo ""

  echo "## Staged files"
  for f in "${STAGED[@]}"; do
    echo "- $f  →  $(classify_file "$f")"
  done
  echo ""

  echo "## Diffs"
  for f in "${STAGED[@]}"; do
    echo ""
    echo "### Diff: $f"
    echo '```diff'
    git diff --cached -- "$f" | head -800
    echo '```'
  done

  echo ""
  echo "## Full file context (post-staged-changes, files under 50KB only)"
  for f in "${STAGED[@]}"; do
    if [[ -f "$f" ]] && [[ $(wc -c < "$f" 2>/dev/null || echo 0) -lt 50000 ]]; then
      echo ""
      echo "### File: $f"
      echo '```'
      cat "$f"
      echo '```'
    fi
  done
} > "$PROMPT_FILE"

# Cost control: small/fast model for informational, stronger model for blocking severities.
case "$TIGHTEST_SEVERITY" in
  any-concern|critical-only)
    MODEL="claude-sonnet-4-6" ;;
  *)
    MODEL="claude-haiku-4-5-20251001" ;;
esac

echo "[review] running claude headless ($MODEL)..."

# Headless run. We deliberately skip --bare here so keychain/OAuth auth works
# for Claude Max users; --bare requires ANTHROPIC_API_KEY which isn't typical
# for personal-laptop dev. Trade-off: ~3-5s extra startup, but it actually works.
# On any tooling failure: allow commit, log warning. Never let infra block work.
if ! REVIEW_OUTPUT=$(claude -p --model "$MODEL" --max-turns 1 --disable-slash-commands < "$PROMPT_FILE" 2>&1); then
  echo "[review] WARNING: claude CLI failed. Allowing commit (do not block on tooling errors)."
  echo "$REVIEW_OUTPUT" | head -20
  exit 0
fi

echo ""
echo "──────── REVIEW ────────"
echo "$REVIEW_OUTPUT"
echo "────────────────────────"
echo ""

# Parse verdict — last occurrence wins.
VERDICT=$(echo "$REVIEW_OUTPUT" | grep -E "^VERDICT: (PASS|BLOCK)" | tail -1 || true)

case "$VERDICT" in
  *BLOCK*)
    if [[ "$TIGHTEST_SEVERITY" == "informational" ]]; then
      echo "[review] reviewer voted BLOCK but severity is informational — allowing commit."
      exit 0
    fi
    echo "[review] BLOCKED. Address the issues above, or bypass with: git commit --no-verify"
    exit 1
    ;;
  *PASS*)
    echo "[review] PASS"
    exit 0
    ;;
  *)
    echo "[review] WARNING: no clear verdict from reviewer."
    if [[ "$TIGHTEST_SEVERITY" == "any-concern" ]]; then
      echo "[review] strict severity, defaulting to BLOCK on unclear verdict."
      exit 1
    fi
    echo "[review] permissive severity, allowing commit."
    exit 0
    ;;
esac
