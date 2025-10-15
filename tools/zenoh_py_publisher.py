#!/usr/bin/env python3
import os, sys, json, signal, socket, atexit
import zenoh
import msgpack

KEY_PREFIX = os.environ.get("ZENOH_KEY_PREFIX", "bsole/sensors")
LOCATOR = "tcp/127.0.0.1:7447"

conf = zenoh.Config()
conf.insert_json5("mode", '"client"')                    # JSON string
conf.insert_json5("connect/endpoints", f'["{LOCATOR}"]') # JSON array

session = zenoh.open(conf)
print(f"[Python-Sidecar] connected to {LOCATOR}", file=sys.stderr)

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

UDS_PATH = "/tmp/bsole-zenoh.sock"

def handle_msg(obj):
    key = str(obj.get("key") or KEY_PREFIX)
    if obj.get("declare") and "json" not in obj:
        _pub_for(key)
        return
    payload = json.dumps(obj.get("json", None), indent=4)
    _pub_for(key).put(payload)

try:
    if os.path.exists(UDS_PATH):
        os.unlink(UDS_PATH)
except Exception:
    pass

def _cleanup_socket(path: str):
    try:
        if os.path.exists(path):
            os.unlink(path)
    except Exception:
        pass

atexit.register(_cleanup_socket, UDS_PATH)
srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
srv.bind(UDS_PATH)
srv.listen(1)
print(f"[Python-Sidecar] UDS listening at {UDS_PATH}", file=sys.stderr)
# Signal readiness only after the socket is listening
print("[Python-Sidecar] READY", flush=True)
conn, _ = srv.accept()
try:
    unpacker = msgpack.Unpacker(raw=False)
    while True:
        data = conn.recv(65536)
        if not data:
            break
        unpacker.feed(data)
        for obj in unpacker:
            try:
                if isinstance(obj, (bytes, bytearray)):
                    obj = json.loads(obj.decode("utf-8", "replace"))
                handle_msg(obj)
            except Exception as e:
                print(f"[Python-Sidecar] bad msgpack/publish error: {e}", file=sys.stderr)
finally:
    try: conn.close()
    except Exception: pass
    try: srv.close()
    except Exception: pass

shutdown()
