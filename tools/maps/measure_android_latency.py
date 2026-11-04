#!/usr/bin/env python3
"""Measure the local Flutter profile app over USB without changing user data.

Requires the profile build's VM service extensions. Exercises read-only route
and search requests and, optionally, map swipes. Writes explicit raw observations
instead of claiming an FPS based on Android's unrelated host window metrics.
"""
import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import re
import subprocess
import time
from urllib.parse import urlencode
from urllib.request import urlopen


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--adb', required=True)
    parser.add_argument('--serial', required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--swipes', action='store_true')
    parser.add_argument('--long-routes', action='store_true')
    parser.add_argument('--restart', action='store_true', help='Measure from a fresh app process')
    parser.add_argument('--over-keyguard', action='store_true', help='Opt in to debuggable test display while locked')
    parser.add_argument('--map-texture-layer', action='store_true', help='With --restart: render the map with texture-layer composition (debug/profile only)')
    parser.add_argument('--event-burst', action='store_true', help='Pan while a burst of Room event updates arrives')
    parser.add_argument('--event-burst-only', action='store_true', help='Skip search/route latency; run only the event burst scenario')
    parser.add_argument('--burst-count', type=int, default=60, help='Room touches or Flutter replays per burst')
    parser.add_argument('--burst-interval-ms', type=int, default=50)
    args = parser.parse_args()
    if args.event_burst_only:
        args.event_burst = True
    if args.map_texture_layer and not args.restart:
        parser.error('--map-texture-layer only applies to a fresh process; add --restart')
    def adb(*command):
        return subprocess.check_output([args.adb,'-s',args.serial,*command],text=True,encoding='utf-8',errors='replace')
    startup = None
    if args.restart:
        adb('shell','am','force-stop','com.resilientgeo.mesh')
        startup = time.monotonic()
        command = ['shell','am','start','-n','com.resilientgeo.mesh/.MainActivity']
        if args.over_keyguard:
            command.extend(['--ez','performance_over_keyguard','true'])
        if args.map_texture_layer:
            command.extend(['--esa','dart_entrypoint_args','--map-texture-layer'])
        adb(*command)
    for _ in range(60):
        try:
            pid = adb('shell','pidof','com.resilientgeo.mesh').strip()
            logs = adb('logcat','-d','--pid',pid,'-s','flutter:I')
            services = re.findall(r'The Dart VM service is listening on http://127\.0\.0\.1:(\d+)/([^\s]+)',logs)
            if services:
                break
        except subprocess.CalledProcessError:
            pass
        time.sleep(.25)
    else:
        services = []
    if not services:
        raise RuntimeError('No VM service for the running app; install/start a profile build first')
    device_port, token = services[-1]
    host_port = adb('forward','tcp:0',f'tcp:{device_port}').strip()
    base = f'http://127.0.0.1:{host_port}/{token.rstrip("/")}/'
    def rpc(method, **params):
        with urlopen(base+method+'?'+urlencode(params),timeout=30) as response:
            payload = json.load(response)
        if 'error' in payload:
            raise RuntimeError(payload['error'])
        return payload['result']
    try:
        isolates = rpc('getVM')['isolates']
        isolate = next(i['id'] for i in isolates if i['name']=='main')
        def call(method, **params):
            return rpc('ext.resilientgeo.'+method,isolateId=isolate,**params)
        observations = {'captured_at':datetime.now(timezone.utc).isoformat(),'device_serial':args.serial}
        def swipe_frames():
            """Pans for ~9 s; returns the frame timings recorded meanwhile."""
            for i in range(12):
                start,end = (750,350) if i%2==0 else (350,750)
                adb('shell','input','swipe',str(start),'1100',str(end),'1100','600')
                time.sleep(.15)
            time.sleep(.8)
            return call('performance')
        # Wait in short intervals for the already-backgrounded search asset.
        for _ in range(60):
            if call('search',query='成功路').get('ready'):
                break
            time.sleep(.5)
        else:
            raise RuntimeError('Search worker did not become ready')
        if startup is not None:
            observations['search_ready_after_start_ms'] = (time.monotonic()-startup)*1000
        if args.event_burst:
            # Same pan gesture three ways: quiet, while Android re-emits the
            # Room event table (mesh-sync shape, no data changed), and while
            # Flutter replays the event snapshot (controller + map rebuilds).
            burst = {'count':args.burst_count,'interval_ms':args.burst_interval_ms}
            observations['event_burst'] = {'parameters':burst}
            call('performance',reset='true')
            observations['event_burst']['quiet_pan_frames'] = swipe_frames()
            for mode in ('native','replay'):
                call('performance',reset='true')
                call('eventBurst',mode=mode,count=args.burst_count,interval_ms=args.burst_interval_ms)
                frames = swipe_frames()
                observations['event_burst'][mode] = {'pan_frames':frames,'result':call('eventBurstResult')}
        if args.event_burst_only:
            observations['dart_memory'] = rpc('getMemoryUsage',isolateId=isolate)
            observations['android_memory'] = adb('shell','dumpsys','meminfo','com.resilientgeo.mesh')
            args.output.parent.mkdir(parents=True,exist_ok=True)
            args.output.write_text(json.dumps(observations,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
            print(json.dumps({'event_burst':observations['event_burst'],'output':str(args.output)},ensure_ascii=False))
            return
        observations['search'] = []
        for query in ['成功路','板橋','中正路','新北市板橋區文化路一段','路']:
            for _ in range(3):
                observations['search'].append({'query':query,**call('search',query=query)})
        pairs = [
            ('taipei',121.517,25.047,121.525,25.048),
            ('banqiao',121.462,25.014,121.459,25.009),
            ('sanchong',121.486,25.055,121.491,25.057),
            ('xindian',121.537,24.967,121.533,24.973),
            ('tamsui',121.445,25.168,121.441,25.171),
            ('cross_city_bridge',121.506,25.062,121.492,25.063),
        ]
        if args.long_routes:
            pairs.extend([
                ('taipei_to_banqiao',121.517,25.047,121.462,25.014),
                ('tamsui_to_banqiao',121.445,25.168,121.462,25.014),
            ])
        observations['routes'] = []
        for name,lon,lat,target_lon,target_lat in pairs:
            for iteration in range(6):
                result = call('routeBenchmark',lon=lon,lat=lat,targetLon=target_lon,targetLat=target_lat)
                observations['routes'].append({'case':name,'iteration':iteration,**result})
        if args.swipes:
            call('performance',reset='true')
            observations['pan_frames'] = swipe_frames()
        observations['dart_memory'] = rpc('getMemoryUsage',isolateId=isolate)
        observations['android_memory'] = adb('shell','dumpsys','meminfo','com.resilientgeo.mesh')
        observations['thermal_status'] = '\n'.join(line for line in adb('shell','dumpsys','thermalservice').splitlines() if 'Thermal Status' in line)
        def p95(values):
            values = sorted(values)
            return values[round((len(values)-1)*.95)]
        observations['summary'] = {
            # Only cold if the caller just restarted the process. A second
            # run in the same app must not label its first request as cold.
            'first_route_ms':observations['routes'][0]['elapsed_ms'],
            'warm_route_p95_ms':p95([r['elapsed_ms'] for r in observations['routes'] if r['iteration']>0]),
            'search_p95_ms':p95([s['elapsed_ms'] for s in observations['search'] if len(s['query'])>=2]),
            'single_character_search_ms':max(s['elapsed_ms'] for s in observations['search'] if len(s['query'])==1),
            'all_routes_ok':all(r['status']=='ok' for r in observations['routes']),
        }
        args.output.parent.mkdir(parents=True,exist_ok=True)
        args.output.write_text(json.dumps(observations,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
        print(json.dumps({'summary':observations['summary'],'pan_frames':observations.get('pan_frames'),'event_burst':observations.get('event_burst'),'thermal_status':observations['thermal_status'],'output':str(args.output)},ensure_ascii=True))
    finally:
        adb('forward','--remove',f'tcp:{host_port}')


if __name__=='__main__':
    main()
