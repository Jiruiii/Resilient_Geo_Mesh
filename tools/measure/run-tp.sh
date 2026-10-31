#!/usr/bin/env bash
set -uo pipefail

# Throughput runs with both phones on USB: TX loads and provides, RX runs the trials.
# Usage: [PLAN=full|all-fast] [COUNT=5] run-tp.sh <distance_m> <notes>
# test_id is tp-<distance>m-<ble|nearby|wifi>-<tier>.
source "$(dirname "$0")/common.sh"

DIST=$1; NOTES=$2; COUNT=${COUNT:-5}

load() { # tier
  "$ADB" -s "$TX" shell am start -n "$ACTIVITY" --es cmd stop >/dev/null 2>&1; sleep 3
  local since; since=$(phone_time "$TX")
  # Load with Nearby selected: BLE refuses tiers above MB1. The tier is kept when the transport changes.
  "$ADB" -s "$TX" shell am start -n "$ACTIVITY" --es cmd load --es role sender --es tier "$1" --es transport nearby >/dev/null 2>&1
  for _ in $(seq 1 60); do
    sleep 5
    local line
    line=$("$ADB" -s "$TX" logcat -d -T "$since" -s MeshMeasure:* | grep -m1 "發送端已載入")
    [ -n "$line" ] && { say "load $1: ${line#*MeshMeasure: }"; return 0; }
  done
  say "load $1 FAILED"; return 1
}

cond() { # transport tier_label timeout gap
  local tr=$1 to=$3 gap=$4
  local id="tp-${DIST}m-${tr/wifi_direct/wifi}-$2"
  local before since n
  before=$(rx_rows "$id" "$DIST" | grep -c .)
  "$ADB" -s "$TX" shell am start -n "$ACTIVITY" --es cmd provide --es role sender --es transport "$tr" >/dev/null 2>&1
  sleep 5
  since=$(phone_time "$RX")
  "$ADB" -s "$RX" shell am start -n "$ACTIVITY" --es cmd trials --es role receiver --es transport "$tr" --es test_id "$id" \
    --es distance "$DIST" --es notes "$NOTES" --ei timeout "$to" --ei gap "$gap" --ei count "$COUNT" >/dev/null 2>&1
  sleep 3
  if refused_since "$RX" "$since"; then say "receiver busy, stopping"; exit 1; fi
  say "start $id (timeout $to, gap $gap)"
  local limit=$(( COUNT * (to + gap + 40) + 120 )) waited=0
  n=$before
  while [ $waited -lt $limit ]; do
    sleep 20; waited=$((waited + 20))
    n=$(rx_rows "$id" "$DIST" | grep -c .)
    [ $((n - before)) -ge "$COUNT" ] && break
  done
  say "done $id: $((n - before))/$COUNT rows, $(rx_rows "$id" "$DIST" | tail -n $((n - before)) | awk -F, '$15 == "true"' | grep -c .) succeeded"
  sleep 5
}

say "run start dist=$DIST notes=$NOTES plan=${PLAN:-full} count=$COUNT"
case "${PLAN:-full}" in
  all-fast) load ALL && { cond nearby all 900 35; cond wifi_direct all 900 10; } ;;
  *)
    load ONE  && { cond ble one 180 10; cond nearby one 180 35; cond wifi_direct one 180 10; }
    load KB50 && { cond ble kb50 180 10; cond nearby kb50 180 35; cond wifi_direct kb50 180 10; }
    # BLE needs ~9 minutes for this tier; the 300 s per-connection cap means one reconnect.
    load MB1  && { cond ble mb1 900 10; cond nearby mb1 300 35; cond wifi_direct mb1 300 10; }
    load MB10 && { cond nearby mb10 600 35; cond wifi_direct mb10 600 10; }
    load ALL  && { cond nearby all 900 35; cond wifi_direct all 900 10; } ;;
esac
"$ADB" -s "$TX" shell am start -n "$ACTIVITY" --es cmd stop >/dev/null 2>&1
say "run end"
