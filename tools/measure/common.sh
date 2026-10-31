# Shared settings for the measurement scripts; sourced, not run.
# Override ADB, TX (sender serial) or RX (receiver serial) in the environment.
export MSYS_NO_PATHCONV=1  # Git Bash: keep /sdcard paths as they are

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
if [ -z "${ADB:-}" ]; then
  ADB="$REPO_ROOT/android/build/toolchains/android-sdk/platform-tools/adb.exe"
  [ -x "$ADB" ] || ADB="$REPO_ROOT/android/build/toolchains/android-sdk/platform-tools/adb"
  [ -x "$ADB" ] || ADB=adb
fi
TX="${TX:-41051JEKB12762}"   # Pixel 8a
RX="${RX:-R5CT8024QLR}"      # Samsung SM-A5360
ACTIVITY=com.resilientgeo.mesh/.debug.MeshMeasureActivity
CSV_DIR=/sdcard/Android/data/com.resilientgeo.mesh/files/measurements

say() { echo "$(date +%H:%M:%S) $*"; }

# The app names its CSV after the phone's date and Build.MODEL.
csv_path() {
  local day model
  day=$("$ADB" -s "$1" shell date +%F | tr -d '\r')
  model=$("$ADB" -s "$1" shell getprop ro.product.model | tr -d '\r' | sed 's/[^A-Za-z0-9_-]/_/g')
  echo "$CSV_DIR/measure-$day-$model.csv"
}

# Receiver rows for one test_id (column 3) and distance (column 9).
rx_rows() {
  "$ADB" -s "$RX" shell cat "$(csv_path "$RX")" 2>/dev/null | tr -d '\r' |
    awk -F, -v id="$1" -v d="$2" '$3 == id && $9 == d'
}

phone_time() { "$ADB" -s "$1" shell 'date "+%m-%d %H:%M:%S.000"' | tr -d '\r'; }

# A command sent while the screen is busy is refused, but its fields are still
# overwritten; fail loudly instead of waiting for rows that never come.
refused_since() {
  "$ADB" -s "$1" logcat -d -T "$2" -s MeshMeasure:* 2>/dev/null | grep -q "請先停止"
}
