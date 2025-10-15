#!/usr/bin/env python3
import os, sys, json, signal
import zenoh

KEY_PREFIX = os.environ.get("ZENOH_KEY_PREFIX", "bsole/sensors")
LOCATOR = os.environ.get("ZENOH_LOCATOR") or "tcp/127.0.0.1:7447"

conf = zenoh.Config()
conf.insert_json5("mode", '"client"')                    # JSON string
conf.insert_json5("connect/endpoints", f'["{LOCATOR}"]') # JSON array

session = zenoh.open(conf)
print(f"[py-sidecar] connected to {LOCATOR}", file=sys.stderr)

publishers = {}

def _pub_for(key: str):
    pub = publishers.get(key)
    if pub is None:
        pub = session.declare_publisher(key)
        publishers[key] = pub
    return pub

def shutdown(*_):
    try:
        for p in list(publishers.values()):
            try: p.undeclare()
            except Exception: pass
        session.close()
    finally:
        try: sys.stderr.flush()
        except Exception: pass
        os._exit(0)

signal.signal(signal.SIGTERM, shutdown)
signal.signal(signal.SIGINT, shutdown)

for raw in sys.stdin:
    line = raw.strip()
    if not line:
        continue
    try:
        msg = json.loads(line)
        key = str(msg.get("key") or KEY_PREFIX)
        payload = json.dumps(msg.get("json", None), separators=(",", ":"))
        _pub_for(key).put(payload)  # send as string (robust across versions)
        # print(f"[py-sidecar] put {key}", file=sys.stderr)  # debug if needed
    except Exception as e:
        print(f"[py-sidecar] bad line/publish error: {e} | line={line}", file=sys.stderr)

shutdown()
