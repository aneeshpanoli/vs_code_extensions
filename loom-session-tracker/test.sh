#!/usr/bin/env bash
# Run the test suite under VSCodium's bundled node (no npm on this machine).
# Usage: ./test.sh [filter]   — a TEST FILE name (preferred, e.g. duties.test.js), else a suite-name
#                                substring. A filter that matches nothing EXITS 3; zero tests run is
#                                never a pass (TI-001).
#
# THIS SCRIPT DOES NOT COMPILE, and the tests load out/ — so run-tests.js REFUSES with EXIT 4 when
# out/ is not a build of src/, rather than grading the previous build (TI-002). Compile with
# `npm run compile`, or the tsc line the refusal prints. Exit codes: 1 test failure, 2 no codium,
# 3 nothing executed, 4 stale build.
set -euo pipefail
cd "$(dirname "$0")"
CODIUM=${CODIUM:-/usr/share/codium/codium}
[ -x "$CODIUM" ] || { echo "codium not found at $CODIUM (set CODIUM=...)" >&2; exit 2; }
ELECTRON_RUN_AS_NODE=1 "$CODIUM" test/run-tests.js "$@"
