#!/usr/bin/env python3
import os, sys, json, time
import zenoh  # pip install 'zenoh==1.6.1'

def dec(v):
    if isinstance(v, (bytes, bytearray)):
        return v.decode("utf-8", "replace")
    return str(v)

LOCATOR = os.environ.get("ZENOH_LOCATOR", "tcp/127.0.0.1:7447")
KEYEXPR = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("ZENOH_SUB", "bsole/sensors/**")

conf = zenoh.Config()
conf.insert_json5("mode", '"client"')                               # <-- JSON string
conf.insert_json5("connect/endpoints", f'["{LOCATOR}"]')            # <-- JSON array

s = zenoh.open(conf)
print(f"[py-sub] connected to {LOCATOR}; subscribing {KEYEXPR}")

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
