#!/usr/bin/env python3
import os, sys, json, signal, socket, atexit, tempfile
import zenoh
import msgpack

KEY_PREFIX = os.environ.get("ZENOH_KEY_PREFIX", "bsole/sensors")
CONFIG_FILE = os.path.join(os.path.dirname(os.path.dirname(__file__)), "config", "peer.json5")
if not os.path.exists(CONFIG_FILE):
    print(f"[PythonSidecar] zenoh peer config not found: {CONFIG_FILE}", file=sys.stderr)
    sys.exit(1)

conf = zenoh.Config.from_file(CONFIG_FILE)
_router_override = os.environ.get("ZENOH_ROUTER")
if _router_override:
    conf.insert_json5("connect/endpoints", f'["{_router_override}"]')
    print(f"[PythonSidecar] router override: {_router_override}", file=sys.stderr)
session = zenoh.open(conf)
print(f"[PythonSidecar] loaded zenoh peer config: {CONFIG_FILE}", file=sys.stderr)

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

UDS_PATH = os.environ.get("ZENOH_UDS_PATH", os.path.join(tempfile.gettempdir(), "bsole-zenoh.sock"))

def handle_msg(obj):
    key = str(obj.get("key") or KEY_PREFIX)
    if obj.get("declare") and "json" not in obj:
        _pub_for(key)
        return
    raw = obj.get("json", None)
    # JS side pre-serializes to a JSON string; accept that directly.
    # Keep legacy object path for backward compat.
    if isinstance(raw, str):
        payload = raw
    elif isinstance(raw, (bytes, bytearray)):
        payload = raw.decode("utf-8", "replace")
    else:
        payload = json.dumps(raw, indent=4, default=str)
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
print(f"[PythonSidecar] UDS listening at {UDS_PATH}", file=sys.stderr)
# Signal readiness only after the socket is listening
print("[PythonSidecar] READY", flush=True)
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
                print(f"[PythonSidecar] bad msgpack/publish error: {e}", file=sys.stderr)
finally:
    try: conn.close()
    except Exception: pass
    try: srv.close()
    except Exception: pass

shutdown()
