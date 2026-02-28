// Zenoh subscriber using Python sidecar bridge
const EventEmitter = require("events");
const { spawn } = require("child_process");
const net = require("net");
const msgpack = require("@msgpack/msgpack");
const path = require("path");

/**
 * ZenohSubscriber - Subscribe to Zenoh topics and receive messages
 * 
 * Uses a Python sidecar to subscribe to topics and forwards messages to Node.js via UDS
 */
class ZenohSubscriber extends EventEmitter {
    constructor(options = {}) {
        super();
        this.keyExpression = options.keyExpression || "bsole/**";
        this._child = null;
        this._childReady = false;
        this._udsPath = options.udsPath || `/tmp/bsole-zenoh-sub-${process.pid}.sock`;
        this._udsServer = null;
        this._udsSocket = null;
    }

    async start() {
        if (this._child) return;

        // Start UDS server first
        await this._startUDSServer();

        // Start Python subscriber sidecar
        await this._startPythonBridge();

        this.emit("ready");
    }

    async _startUDSServer() {
        return new Promise((resolve, reject) => {
            const server = net.createServer((socket) => {
                this._udsSocket = socket;

                let buffer = Buffer.alloc(0);

                socket.on("data", (chunk) => {
                    buffer = Buffer.concat([buffer, chunk]);

                    // Try to decode messages
                    while (buffer.length > 0) {
                        try {
                            const decoded = msgpack.decodeMulti(buffer);
                            for (const msg of decoded) {
                                buffer = Buffer.alloc(0); // Reset buffer after successful decode

                                if (msg && msg.key && msg.payload) {
                                    // Parse JSON payload
                                    let payload = msg.payload;
                                    if (typeof payload === "string") {
                                        try {
                                            payload = JSON.parse(payload);
                                        } catch {
                                            // Keep as string if not JSON
                                        }
                                    }

                                    // Emit message event
                                    this.emit("message", {
                                        key: msg.key,
                                        payload: payload,
                                    });
                                }
                            }
                        } catch (e) {
                            // Not enough data yet, wait for more
                            break;
                        }
                    }
                });

                socket.on("error", (err) => {
                    this.emit("error", new Error(`UDS socket error: ${err.message}`));
                });

                socket.on("close", () => {
                    this._udsSocket = null;
                });
            });

            server.listen(this._udsPath, () => {
                this._udsServer = server;
                resolve();
            });

            server.on("error", (err) => {
                reject(new Error(`UDS server error: ${err.message}`));
            });
        });
    }

    async _startPythonBridge() {
        const script = path.resolve(__dirname, "../tools/zenoh_py_subscriber_bridge.py");
        const fs = require("fs");
        let pyBin = "python3";
        const venvPyBin = path.resolve(__dirname, "../venv/bin/python3");
        if (fs.existsSync(venvPyBin)) {
            pyBin = venvPyBin;
        }
        const args = ["-u", script, this.keyExpression, this._udsPath];

        const child = spawn(pyBin, args, {
            stdio: ["ignore", "pipe", "inherit"],
        });

        this._child = child;

        child.on("error", (err) => {
            this.emit("error", new Error(`Python subscriber error: ${err.message}`));
        });

        child.on("exit", (code, signal) => {
            if (code !== 0) {
                this.emit("error", new Error(`Python subscriber exited with code ${code}`));
            }
            this._child = null;
            this._childReady = false;
        });

        // Wait for readiness
        await new Promise((resolve) => {
            const onData = (chunk) => {
                const txt = chunk.toString();
                if (txt.includes("[SubscriberBridge] READY")) {
                    child.stdout.off("data", onData);
                    this._childReady = true;
                    resolve();
                }
            };
            child.stdout.on("data", onData);
        });
    }

    async stop() {
        try {
            if (this._udsSocket) {
                this._udsSocket.end();
                this._udsSocket.destroy();
                this._udsSocket = null;
            }

            if (this._udsServer) {
                this._udsServer.close();
                this._udsServer = null;
            }

            if (this._child) {
                this._child.kill("SIGTERM");
                this._child = null;
            }

            this._childReady = false;
        } catch (e) {
            this.emit("error", e);
        }
    }
}

module.exports = { ZenohSubscriber };
