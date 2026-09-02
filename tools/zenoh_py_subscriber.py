#!/usr/bin/env python3
# ! THIS SUBSCRIBER IS FOR DEBUG PURPOSES, NOT FOR TRASNFERING OUTSIDE INFORMATION TO THE BSOLE CONNECTOR
import os, sys, json, time
import zenoh

def dec(v):
    if isinstance(v, (bytes, bytearray)):
        return v.decode("utf-8", "replace")
    return str(v)

KEYEXPR = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("ZENOH_SUB", "bsole/sensors/**")
CONFIG_FILE = os.path.join(os.path.dirname(os.path.dirname(__file__)), "config", "peer.json5")
if not os.path.exists(CONFIG_FILE):
    print(f"[PythonSidecar] zenoh peer config not found: {CONFIG_FILE}", file=sys.stderr)
    sys.exit(1)

conf = zenoh.Config.from_file(CONFIG_FILE)
s = zenoh.open(conf)
print(f"[PythonSidecar] loaded zenoh peer config: {CONFIG_FILE}; subscribing {KEYEXPR}")

def cb(sample):
    key = getattr(sample, "key_expr", None) or getattr(sample, "key", "<key>")
    val = getattr(sample, "payload", None)
    text = dec(val) if val is not None else ""
    try:
        pretty = json.dumps(json.loads(text), indent=2)
    except Exception:
        pretty = text
    print(f"[{time.strftime('%H:%M:%S')}] {key}\n{pretty}\n", flush=True)

sub = s.declare_subscriber(KEYEXPR, cb)
try:
    while True:
        time.sleep(1)
except KeyboardInterrupt:
    pass
finally:
    try: sub.undeclare()
    except Exception: pass
    s.close()
