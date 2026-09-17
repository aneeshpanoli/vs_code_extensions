#!/usr/bin/env bash
# Run the test suite under VSCodium's bundled node (no npm on this machine).
# Usage: ./test.sh [filter]   — a TEST FILE name (preferred, e.g. duties.test.js), else a suite-name
#                                substring. A filter that matches nothing EXITS 3; zero tests run is
#                                never a pass (TI-001).
set -euo pipefail
cd "$(dirname "$0")"
CODIUM=${CODIUM:-/usr/share/codium/codium}
[ -x "$CODIUM" ] || { echo "codium not found at $CODIUM (set CODIUM=...)" >&2; exit 2; }
ELECTRON_RUN_AS_NODE=1 "$CODIUM" test/run-tests.js "$@"
