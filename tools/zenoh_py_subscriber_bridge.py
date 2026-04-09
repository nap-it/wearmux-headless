#!/usr/bin/env python3
"""
Zenoh Subscriber Bridge - Subscribes to Zenoh topics and forwards messages to Node.js via UDS
"""

import os
import sys
import json
import time
import socket
import struct
import msgpack
import zenoh


def main():
    if len(sys.argv) < 3:
        print(
            "[SubscriberBridge] Usage: zenoh_py_subscriber_bridge.py <key_expression> <uds_path>",
            file=sys.stderr,
        )
        sys.exit(1)

    key_expression = sys.argv[1]
    uds_path = sys.argv[2]

    # Load Zenoh config
    config_file = os.path.join(
        os.path.dirname(os.path.dirname(__file__)), "config", "peer.json5"
    )
    if not os.path.exists(config_file):
        print(
            f"[SubscriberBridge] Zenoh peer config not found: {config_file}",
            file=sys.stderr,
        )
        sys.exit(1)

    conf = zenoh.Config.from_file(config_file)
    router_override = os.environ.get("ZENOH_ROUTER")
    if router_override:
        conf.insert_json5("connect/endpoints", f'["{router_override}"]')
        print(f"[SubscriberBridge] router override: {router_override}", flush=True)
    session = zenoh.open(conf)

    # Connect to UDS
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)

    # Wait for UDS server to be ready
    max_retries = 50
    for i in range(max_retries):
        try:
            sock.connect(uds_path)
            break
        except (FileNotFoundError, ConnectionRefusedError):
            if i == max_retries - 1:
                print(
                    f"[SubscriberBridge] Failed to connect to UDS: {uds_path}",
                    file=sys.stderr,
                )
                sys.exit(1)
            time.sleep(0.1)

    print(f"[SubscriberBridge] Connected to UDS: {uds_path}", flush=True)
    print(f"[SubscriberBridge] Subscribing to: {key_expression}", flush=True)
    print("[SubscriberBridge] READY", flush=True)

    def callback(sample):
        try:
            key = str(sample.key_expr)
            payload_bytes = bytes(sample.payload)

            # Try to decode as UTF-8 string
            try:
                payload_str = payload_bytes.decode("utf-8")
            except:
                payload_str = payload_bytes.hex()

            # Pack message with msgpack
            message = {
                "key": key,
                "payload": payload_str,
            }

            packed = msgpack.packb(message)

            # Send to Node.js parent via UDS
            try:
                sock.sendall(packed)
            except (BrokenPipeError, ConnectionResetError):
                print(
                    "[SubscriberBridge] Node.js parent disconnected. Exiting.",
                    file=sys.stderr,
                    flush=True,
                )
                sys.exit(0)

        except Exception as e:
            print(
                f"[SubscriberBridge] Error processing message: {e}",
                file=sys.stderr,
                flush=True,
            )

    # Subscribe
    subscriber = session.declare_subscriber(key_expression, callback)

    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        pass
    finally:
        try:
            subscriber.undeclare()
        except:
            pass
        session.close()
        sock.close()


if __name__ == "__main__":
    main()
