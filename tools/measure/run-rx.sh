#!/usr/bin/env bash
set -uo pipefail

# Receiver-only trials: the receiver stays on USB, the sender is away from the PC
# and is switched by hand. Prints one line per trial when done:
# trial, success, failure_reason, attempts, t_discover_ms, elapsed_ms, received_bytes, rssi_median.
# Usage: run-rx.sh <ble|nearby|wifi_direct> <distance_m> <test_id> <notes> [count=5] [timeout=180] [gap]
# The gap defaults to 35 s for Nearby (Play services needs ~30 s to release) and 10 s otherwise.
source "$(dirname "$0")/common.sh"

TR=$1; DIST=$2; ID=$3; NOTES=$4; COUNT=${5:-5}; TIMEOUT=${6:-180}
GAP=${7:-$([ "$TR" = nearby ] && echo 35 || echo 10)}

before=$(rx_rows "$ID" "$DIST" | grep -c .)
since=$(phone_time "$RX")
"$ADB" -s "$RX" shell am start -n "$ACTIVITY" --es cmd trials --es role receiver --es transport "$TR" \
  --es test_id "$ID" --es distance "$DIST" --es notes "$NOTES" \
  --ei timeout "$TIMEOUT" --ei gap "$GAP" --ei count "$COUNT" >/dev/null 2>&1
sleep 3
if refused_since "$RX" "$since"; then
  say "receiver is still busy; press 停止 or run: adb -s $RX shell am start -n $ACTIVITY --es cmd stop"
  exit 1
fi
say "start $ID ${DIST}m x$COUNT"

limit=$(( COUNT * (TIMEOUT + GAP + 40) + 120 )); waited=0; n=$before
while [ $waited -lt $limit ]; do
  sleep 10; waited=$((waited + 10))
  n=$(rx_rows "$ID" "$DIST" | grep -c .)
  [ $((n - before)) -ge "$COUNT" ] && break
done
say "done $ID ${DIST}m: $((n - before))/$COUNT rows"
rx_rows "$ID" "$DIST" | tail -n $((n - before)) | cut -d, -f4,15,16,17,18,25,29,33
