#!/usr/bin/env bash
# Records one workflow on this Mac: the main display and the cursor, until Ctrl+C.
#
#   tools/heatmap/record.sh <name>
#
# The raw recording lands in tools/heatmap/.recordings/<name>; render it with render.sh.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
name="${1:?usage: record.sh <name>}"

mkdir -p "$here/.build"
if [[ ! -x "$here/.build/record" || "$here/record.swift" -nt "$here/.build/record" ]]; then
  echo "Building the recorder…"
  swiftc -O -o "$here/.build/record" "$here/record.swift"
fi

exec "$here/.build/record" "$here/.recordings/$name"
