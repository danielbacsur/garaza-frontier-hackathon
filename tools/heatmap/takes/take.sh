#!/usr/bin/env bash
# Performs one take: opens the start page in Safari, records the screen and cursor, plays the hand
# script with the real mouse, stops the recorder.
#
#   tools/heatmap/takes/take.sh <name> <start-url> <script.hand>
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
name="$1" url="$2" script="$3"

osascript -e "tell application \"Safari\" to set URL of current tab of front window to \"$url\"" -e 'tell application "Safari" to activate'
sleep 5
echo "move 760 520" | "$here/.build/hand" -

log="$(mktemp)"
"$here/.build/record" "$here/.recordings/$name" >"$log" 2>&1 &
recorder=$!
until grep -q "Recording" "$log"; do sleep 0.2; done

"$here/.build/hand" "$script"

kill -INT "$recorder"
wait "$recorder" || true
cat "$log" | grep -v objc
