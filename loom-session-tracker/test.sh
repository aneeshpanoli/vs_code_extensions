#!/usr/bin/env bash
# Run the test suite under VSCodium's bundled node (no npm on this machine).
# Usage: ./test.sh [name-filter]
set -euo pipefail
cd "$(dirname "$0")"
CODIUM=${CODIUM:-/usr/share/codium/codium}
[ -x "$CODIUM" ] || { echo "codium not found at $CODIUM (set CODIUM=...)" >&2; exit 2; }
ELECTRON_RUN_AS_NODE=1 "$CODIUM" test/run-tests.js "$@"
