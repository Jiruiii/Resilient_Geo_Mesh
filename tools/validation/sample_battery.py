"""Read-only battery samples. Does not fake unplugging or change radio/power settings.

Use the same device/settings/duration for baseline, balanced and adaptive runs.
ADB polling itself disturbs sleep. USB-powered runs cannot prove discharge savings.
"""
import argparse
import csv
import json
import re
import subprocess
import time
from datetime import datetime, timezone
from pathlib import Path


def parse_battery(text):
    fields = dict(re.findall(r"^\s*([^:\n]+):\s*([^\n]*)", text, re.M))
    def number(key):
        try:
            return int(fields[key].strip())
        except (KeyError, ValueError):
            return None
    powered = [fields.get(key, '').strip().lower() for key in ('AC powered', 'USB powered', 'Wireless powered')]
    plugged = True if 'true' in powered else False if all(v == 'false' for v in powered) else None
    # Newer Android adds a dock supply independently of AC/USB/wireless.
    if fields.get('Dock powered', '').strip().lower() == 'true':
        plugged = True
    return {'level': number('level'), 'charge_uah': number('Charge counter'),
            'temperature_deci_c': number('temperature'), 'status': number('status'), 'plugged': plugged}


def summarize(samples):
    eligible = len(samples) >= 2 and all(s['plugged'] is False and s['status'] == 3 and s['charge_uah'] is not None for s in samples)
    delta = samples[0]['charge_uah'] - samples[-1]['charge_uah'] if eligible else None
    if delta is not None and delta < 0:
        eligible, delta = False, None
    return {'samples': len(samples), 'discharge_counter_usable': eligible, 'charge_used_uah': delta,
            'limitations': 'Not an app-only power measurement. ADB polling affects sleep; charging/missing counters invalidate discharge comparisons. Pair with identical baseline conditions.'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--adb', default='adb')
    parser.add_argument('--serial', required=True)
    parser.add_argument('--mode', choices=['baseline', 'balanced', 'adaptive'], required=True, help='Label only; select the actual mode in the app first')
    parser.add_argument('--seconds', type=int, default=1800)
    parser.add_argument('--interval', type=int, default=30)
    parser.add_argument('--output', type=Path, required=True, help='New CSV filename; existing files are never overwritten')
    args = parser.parse_args()
    if args.seconds < 1 or args.interval < 1:
        parser.error('seconds and interval must be positive')
    samples = []
    args.output.parent.mkdir(parents=True, exist_ok=True)
    started = time.monotonic()
    with args.output.open('x', newline='', encoding='utf-8') as output:
        writer = csv.DictWriter(output, fieldnames=['time_utc', 'elapsed_seconds', 'mode', 'level', 'charge_uah', 'temperature_deci_c', 'status', 'plugged'])
        writer.writeheader()
        while True:
            result = subprocess.run([args.adb, '-s', args.serial, 'shell', 'dumpsys', 'battery'], capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=20, check=True)
            sample = {'time_utc': datetime.now(timezone.utc).isoformat(), 'elapsed_seconds': round(time.monotonic() - started, 3), 'mode': args.mode, **parse_battery(result.stdout)}
            samples.append(sample); writer.writerow(sample); output.flush()
            remaining = args.seconds - (time.monotonic() - started)
            if remaining <= 0:
                break
            time.sleep(min(args.interval, remaining))
    # Sidecar is also exclusive, so earlier measurement reports are preserved.
    summary = summarize(samples)
    with args.output.with_suffix('.json').open('x', encoding='utf-8') as output:
        json.dump(summary, output, indent=2)
    print(json.dumps(summary), flush=True)


if __name__ == '__main__':
    main()
