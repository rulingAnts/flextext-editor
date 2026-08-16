#!/usr/bin/env bash
# Install the tracked git hooks into .git/hooks (which git does not version).
#
# ⚠ NEVER OVERWRITES AN EXISTING HOOK. Seth's Mac already carries a pre-push with the workflow and
# production guards in it, written before this file existed. Silently replacing it would be a
# guard-changing act disguised as a setup step — so if a hook is already there and differs, this
# prints the diff and stops, and the human decides.
set -uo pipefail
cd "$(dirname "$0")" || exit 2
mkdir -p .git/hooks || { echo "install-hooks: no .git/hooks here — is this a git checkout?" >&2; exit 2; }

status=0
for src in hooks/*; do
  [ -f "$src" ] || continue
  name=$(basename "$src")
  dst=".git/hooks/$name"
  if [ ! -e "$dst" ]; then
    cp "$src" "$dst" && chmod +x "$dst" && echo "installed  $dst"
  elif cmp -s "$src" "$dst"; then
    echo "up to date $dst"
  else
    echo "⚠ EXISTS AND DIFFERS: $dst" >&2
    echo "  Not touching it. Review and merge by hand — the installed one may carry guards this" >&2
    echo "  repo's copy does not. Difference (installed → tracked):" >&2
    diff -u "$dst" "$src" | sed 's/^/    /' >&2
    echo "  To take the tracked version once you have read it:  cp $src $dst && chmod +x $dst" >&2
    status=1
  fi
done

echo
echo "Belt and braces — do these on GitHub too, once per repo (free on public repos):"
echo "  • Secret scanning: ON        — finds credentials already pushed"
echo "  • PUSH PROTECTION: ON        — the half that BLOCKS the push instead of reporting after it"
echo "  Settings → Code security. Push protection is the one that would have helped; scanning alone"
echo "  tells you after the bytes are already public."
exit $status
