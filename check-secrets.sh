#!/usr/bin/env bash
# ⚠ DO NOT COMMIT SECRETS — the check that runs before a push can put them on the public internet.
#
# Seth, 2026-08-15, after credentials in a OneStory project file sat in a public repo: "let's have
# more careful guards to make sure we check for and don't upload secrets publicly in the future."
#
# ⚠ WHY THIS RUNS BEFORE THE PUSH, NOT AFTER. A commit is local and reversible; a PUSH to a public
# repo is neither. From the moment a secret is pushed it is cloned, cached and indexed, and deleting
# it later removes NOTHING — the blob stays fetchable until the history is rewritten, and the
# credential must be rotated regardless. So the only cheap moment is before the bytes leave.
#
# ⚠ AND WHY IT IS DELIBERATELY NARROW. This repo's own rule, written into its tests: "a check that
# cries wolf gets muted, which is worse than no check." Every pattern below matches a credential
# FORMAT (a key's own prefix, a PEM header) or a file type that exists to hold one — not the words
# "password" or "secret", which appear all over legitimate source. Adding a fuzzy pattern here is
# how this file ends up bypassed with --no-verify by reflex, at which point it protects nothing.
#
# Usage:
#   ./check-secrets.sh              # scan what is TRACKED (what a fresh clone would receive)
#   ./check-secrets.sh --staged     # scan the staged diff (pre-commit)
#   ./check-secrets.sh --range A..B # scan files changed in a commit range (pre-push)
# Exit 0 = clean, 1 = something that looks like a credential, 2 = bad usage.

set -uo pipefail
cd "$(dirname "$0")" || exit 2

MODE="tracked"; RANGE=""
case "${1:-}" in
  --staged) MODE="staged" ;;
  --range)  MODE="range"; RANGE="${2:-}"; [ -n "$RANGE" ] || { echo "usage: $0 --range A..B" >&2; exit 2; } ;;
  "")       ;;
  *)        echo "usage: $0 [--staged | --range A..B]" >&2; exit 2 ;;
esac

case "$MODE" in
  staged)  FILES=$(git diff --cached --name-only --diff-filter=ACMR) ;;
  range)   FILES=$(git log --diff-filter=ACMR --name-only --pretty=format: "$RANGE" 2>/dev/null | sort -u) ;;
  tracked) FILES=$(git ls-files) ;;
esac

# ⚠⚠ SCAN THE BYTES THAT ARE ACTUALLY PUSHED / COMMITTED, NOT THE WORKING TREE. The old code listed
#   the changed files and then grepped the CURRENT copy on disk — so a secret added in one commit and
#   redacted in a later commit of the same push scanned clean, while the blob carrying it shipped
#   anyway (sweep #10). The whole premise of this guard is that a push to a public repo is
#   irreversible, so it must inspect what the push contains:
#     range  → every ADDED line across the range's history (the redact-in-a-later-commit case), via
#              `git log -p`; a line a commit introduced is caught even if a sibling commit removes it.
#     staged → the STAGED blob (`git show :path`), which is what a commit will contain — not an
#              unstaged working-tree edit that will not be committed.
#     tracked→ the working tree, which is the right thing for "is the tree as it stands clean".
scan_source() {
  case "$MODE" in
    range)  git log -p --no-color -U0 "$RANGE" -- "$1" 2>/dev/null | grep '^+' ;;
    staged) git show ":$1" 2>/dev/null ;;
    *)      cat "$1" 2>/dev/null ;;
  esac
}
[ -n "${FILES:-}" ] || { echo "check-secrets: nothing to scan."; exit 0; }

# ⚠ THIS FILE AND ITS DOCUMENTATION DESCRIBE THE PATTERNS, so they match themselves. A guard that
# fails on its own definition is a guard someone disables on day one. Excluded by name, and ONLY
# these — never a directory, or a real secret dropped inside one would sail through.
is_selfref() {
  case "$1" in
    check-secrets.sh|hooks/pre-push|install-hooks.sh|CLAUDE.md|DEVELOPERS.md|test/secret-guard.test.mjs) return 0 ;;
    # ⚠ NOT plans/* — a directory exemption is a hole, and this list had one for about ten minutes.
    # The plans docs are prose ABOUT credentials; if one ever trips a pattern, that is a fact worth
    # seeing, not one to pre-suppress. Name individual files here or nothing.
    *) return 1 ;;
  esac
}

# FILE TYPES that exist to hold credentials, or carry other people's personal data. `.onestory` is
# here because that is the file that started this: a project file with member records in it.
BAD_NAMES='(^|/)(\.env(\.[A-Za-z0-9_-]+)?|\.dev\.vars|\.netrc|\.npmrc|id_rsa|id_dsa|id_ecdsa|id_ed25519|credentials\.json|service[-_]account.*\.json|.*\.(pem|key|p12|pfx|jks|keystore|onestory|ppk))$'
# …minus the ones whose whole purpose is to be committed as a TEMPLATE.
OK_NAMES='(\.example|\.sample|\.template|\.md)$|^docs/icons/|(^|/)dev-cert\.example'

# CREDENTIAL FORMATS. Each matches the shape a real key has — its issuer prefix or its own header.
PATTERNS=(
  '-----BEGIN [A-Z ]*PRIVATE KEY-----'          # any PEM private key
  'gh[pousr]_[A-Za-z0-9]{30,}'                  # GitHub personal / OAuth / server / refresh token
  'github_pat_[A-Za-z0-9_]{30,}'                # GitHub fine-grained PAT
  'AKIA[0-9A-Z]{16}'                            # AWS access key id
  'ASIA[0-9A-Z]{16}'                            # AWS temporary access key id
  'AIza[0-9A-Za-z_-]{35}'                       # Google API key
  'ya29\.[0-9A-Za-z_-]{20,}'                    # Google OAuth access token
  'sk-[A-Za-z0-9]{32,}'                         # OpenAI-style secret key
  'sk_live_[0-9a-zA-Z]{20,}'                    # Stripe live secret
  'xox[abposr]-[0-9A-Za-z-]{10,}'               # Slack token
  'SG\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}'  # SendGrid
  'https?://[^/[:space:]:]+:[^/[:space:]@]+@'   # credentials embedded in a URL
  '"private_key_id"[[:space:]]*:'               # Google service-account JSON
)

fails=0
report() { printf '  %s\n    %s\n' "$1" "$2"; fails=$((fails+1)); }

echo "check-secrets: scanning ${MODE}…"
for f in $FILES; do
  is_selfref "$f" && continue

  if printf '%s' "$f" | grep -qiE "$BAD_NAMES" && ! printf '%s' "$f" | grep -qiE "$OK_NAMES"; then
    report "FILE TYPE  $f" "this kind of file exists to hold credentials or personal data — it should not be tracked"
    continue      # do not also grep it; one clear reason beats two
  fi

  content=$(scan_source "$f")
  [ -n "$content" ] || continue

  # Skip binaries: a false positive inside a DLL is noise, and a credential pasted into one is not
  # the failure mode anyone has. `-I` makes grep treat binary as non-matching.
  for p in "${PATTERNS[@]}"; do
    # ⚠ `-e` IS LOAD-BEARING, not tidiness. The PEM pattern begins with `-----`, so without it grep
    # parses the pattern as OPTIONS and dies with "unrecognized option" — and because stderr is
    # discarded and the failure is tolerated, the miss was completely silent. The result: the very
    # first rule in the list, "any PEM private key", never fired once in a file not already caught by
    # its .pem EXTENSION (found 2026-08-24 by mutation-testing the guard's own test, which had been
    # crediting the extension rule for the content rule's assertion). Any pattern starting with `-`
    # is unreachable without this.
    hit=$(printf '%s' "$content" | grep -InE -m1 -e "$p" 2>/dev/null | head -1) || true
    if [ -n "$hit" ]; then
      report "CREDENTIAL $f:${hit%%:*}" "matches the format of a real key — rotate it if it is genuine, and do not push"
      break
    fi
  done
done

if [ "$fails" -gt 0 ]; then
  cat >&2 <<'EOS'

check-secrets: FAILED — the above must not reach a public repository.

  If it is a REAL credential:
    1. ROTATE IT NOW. That is the only step that ends the exposure; everything else is cleanup.
    2. Remove it from the working tree, and from history if it was ever committed
       (git filter-repo / BFG, then a force-push). A delete commit is NOT enough.
    3. Add it to .gitignore so the next copy is not offered again.

  If it is a false positive, add a template suffix (.example/.sample/.template) or, if it truly
  belongs in the repo, extend OK_NAMES in check-secrets.sh in the SAME commit — so the exception
  is reviewable, rather than living in someone's --no-verify habit.
EOS
  exit 1
fi

echo "check-secrets: clean."
exit 0
