#!/usr/bin/env bash
# CANNESS build contract v1: run the built executable once and print its
# CANNESS_RESULT line. The runner parses the last CANNESS_RESULT line.
#
# The executable is the one build.sh recorded in .canness-exe (its last stdout
# line also names it). The runner sources set_env.sh and sets flock and
# ASCEND_VISIBLE_DEVICES before calling this script.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXE_FILE="$HERE/.canness-exe"

if [[ ! -f "$EXE_FILE" ]]; then
  echo "run_once.sh: build.sh has not produced .canness-exe; run build.sh first" >&2
  exit 2
fi

EXE="$(head -n 1 "$EXE_FILE")"
if [[ ! -x "$EXE" ]]; then
  echo "run_once.sh: executable not found: $EXE" >&2
  exit 2
fi

# One correctness run. Accuracy status is in the CANNESS_RESULT JSON; a
# non-zero badCount is a valid measurement, not a script failure.
"$EXE"
