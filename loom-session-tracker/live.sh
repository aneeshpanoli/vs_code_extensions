#!/usr/bin/env bash
# Run the live invariant check under VSCodium's bundled node (no npm on this machine).
# Read-only: it opens a CDP read and reads files. It never injects, writes or closes anything.
# Usage: ./live.sh
set -euo pipefail
cd "$(dirname "$0")"
CODIUM=${CODIUM:-/usr/share/codium/codium}
[ -x "$CODIUM" ] || { echo "codium not found at $CODIUM (set CODIUM=...)" >&2; exit 2; }
ELECTRON_RUN_AS_NODE=1 "$CODIUM" live-check.js "$@"
