#!/usr/bin/env bash
set -uo pipefail

# The 環境 spinner has no adb extra, so pick it with UI taps and print what it shows afterwards.
# Usage: set-env.sh <室外空曠|室內走廊|隔一道牆|跨一層樓|口袋或背包|擁擠環境|其他> [serial=$RX]
source "$(dirname "$0")/common.sh"

WANT=$1; S=${2:-$RX}
ENVS='室外空曠|室內走廊|隔一道牆|跨一層樓|口袋或背包|擁擠環境|其他'

dump() { "$ADB" -s "$S" shell uiautomator dump /sdcard/ui.xml >/dev/null && "$ADB" -s "$S" shell cat /sdcard/ui.xml; }
center() { # "x y" of the first node whose text matches $1
  dump | grep -oE "text=\"($1)\"[^>]*bounds=\"\[[0-9]+,[0-9]+\]\[[0-9]+,[0-9]+\]\"" | head -1 |
    sed -E 's/.*bounds="\[([0-9]+),([0-9]+)\]\[([0-9]+),([0-9]+)\]"/\1 \2 \3 \4/' |
    awk '{print int(($1 + $3) / 2), int(($2 + $4) / 2)}'
}

"$ADB" -s "$S" shell am start -n "$ACTIVITY" >/dev/null 2>&1; sleep 1
pos=$(center "$ENVS"); [ -z "$pos" ] && { echo "環境 spinner not on screen"; exit 1; }
"$ADB" -s "$S" shell input tap $pos; sleep 1
pos=$(center "$WANT"); [ -z "$pos" ] && { echo "option $WANT not found"; exit 1; }
"$ADB" -s "$S" shell input tap $pos; sleep 1
dump | grep -oE "text=\"($ENVS)\"" | head -1
