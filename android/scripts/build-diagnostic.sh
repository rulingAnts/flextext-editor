#!/usr/bin/env bash
# Backwards-compatible entry point: build the capability diagnostic into the recorder shell.
# Equivalent to: scripts/build.sh recorder --diagnostic
exec "$(dirname "$0")/build.sh" "${1:-recorder}" --diagnostic
