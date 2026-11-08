#!/usr/bin/env bash
# Renders a recording into a heatmap GIF for the dashboard: the screen, sped up, with the recent heat
# over it (older spots cooling off), a tail behind the pointer and every click rippling, all dying out
# over the held end. The still is the heatmap of the whole workflow.
#
#   tools/heatmap/render.sh <name> [--title "…"] [--app "…"] [--by "…"]
#                           [--start <s>] [--end <s>] [--speed 1.5] [--width 960] [--fps 12]
#                           [--half-life 2.5] [--tail 0.9] [--lag 0.02]
#
# --start and --end trim the recording (in seconds of video), e.g. to cut switching to the terminal.
# --half-life is how many seconds of video a spot takes to cool to half, --tail how far back the tail
# behind the pointer reaches, --lag how far the screen runs behind the cursor log.
# Writes apps/dashboard/public/heatmaps/<name>.{gif,png,json}.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"
name="${1:?usage: render.sh <name> [options]}"
shift

title="$name" app="" by="" start=0 end="" speed=1.5 width=960 fps=12 hold=2.5 extra=()
while (($#)); do
  case "$1" in
    --title) title="$2" ;;
    --app) app="$2" ;;
    --by) by="$2" ;;
    --start) start="$2" ;;
    --end) end="$2" ;;
    --speed) speed="$2" ;;
    --width) width="$2" ;;
    --fps) fps="$2" ;;
    --hold) hold="$2" ;;
    --half-life | --scale | --steps | --travel | --tail | --lag) extra+=("$1" "$2") ;;
    *) echo "unknown option $1" >&2; exit 64 ;;
  esac
  shift 2
done

rec="$here/.recordings/$name"
out="$root/apps/dashboard/public/heatmaps"
[[ -f "$rec/meta.json" ]] || { echo "No recording at $rec. Record it with record.sh first." >&2; exit 1; }
mkdir -p "$out"

video="$(ls "$rec"/screen.* | head -1)"
# A driven recording's WebM has no duration in its header, so fall back to its last frame's time.
length="$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$video")"
if [[ -z "$length" || "$length" == "N/A" ]]; then
  length="$(ffprobe -v error -select_streams v -show_entries frame=pts_time -of csv=p=0 "$video" | tail -1)"
fi
end="${end:-$length}"

mkdir -p "$here/.build"
if [[ ! -x "$here/.build/render" || "$here/render.swift" -nt "$here/.build/render" ]]; then
  echo "Building the renderer…"
  swiftc -O -o "$here/.build/render" "$here/render.swift"
fi

"$here/.build/render" "$rec" "$out/$name.json" \
  --width "$width" --fps "$fps" --speed "$speed" --hold "$hold" --start "$start" --end "$end" \
  --title "$title" --app "$app" --by "$by" ${extra[@]+"${extra[@]}"}

height="$(python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['height'])" "$out/$name.json")"

echo "Encoding the GIF…"
# The screen is sped up to the overlay's pace and its last frame held under the finished heatmap; one
# palette for the whole clip, built from what changes between frames, keeps the heat colours clean.
ffmpeg -hide_banner -loglevel error -y \
  -ss "$start" -to "$end" -i "$video" \
  -framerate "$fps" -i "$rec/overlay/%05d.png" \
  -filter_complex "[0:v]setpts=(PTS-STARTPTS)/$speed,fps=$fps,scale=$width:$height:flags=lanczos,tpad=stop_mode=clone:stop_duration=$hold[screen];\
[screen][1:v]overlay=0:0:shortest=1,split[a][b];\
[a]palettegen=max_colors=224:stats_mode=diff[palette];\
[b][palette]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle" \
  "$out/$name.gif"

# A still of the whole workflow's heatmap, for slides.
ffmpeg -hide_banner -loglevel error -y \
  -ss "$(python3 -c "print(max(0, $end - 0.2))")" -i "$video" -i "$rec/summary.png" \
  -filter_complex "[0:v]scale=$((width * 2)):$((height * 2)):flags=lanczos[s];[1:v]scale=$((width * 2)):$((height * 2)):flags=bicubic[h];[s][h]overlay,format=rgb24" \
  -frames:v 1 -update 1 "$out/$name.png"

echo "Wrote $out/$name.gif ($(du -h "$out/$name.gif" | cut -f1)) and $name.png"
