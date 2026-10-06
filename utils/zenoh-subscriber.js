// Zenoh subscriber using Python sidecar bridge
const EventEmitter = require("events");
const { spawn } = require("child_process");
const net = require("net");
const { Readable } = require("stream");
const msgpack = require("@msgpack/msgpack");
const path = require("path");
const os = require("os");
const { randomUUID } = require("crypto");
const { topic } = require("./topics");

/**
 * ZenohSubscriber - Subscribe to Zenoh topics and receive messages
 * 
 * Uses a Python sidecar to subscribe to topics and forwards messages to Node.js via UDS
 */
/**
 * Receives Zenoh messages from the Python sidecar through a local UDS server.
 * @class
 * @extends EventEmitter
 * @param {Object} [options]
 * @param {string} [options.keyExpression] Zenoh expression; defaults to the project root.
 * @param {string} [options.udsPath] Local Unix socket path; generated when omitted.
 */
class ZenohSubscriber extends EventEmitter {
    /**
     * Create a Zenoh subscriber backed by a Python sidecar.
     * @param {Object} [options]
     * @param {string} [options.keyExpression] Zenoh subscription expression.
     * @param {string} [options.udsPath] Unix socket path.
     */
    constructor(options = {}) {
        super();
        this.keyExpression = options.keyExpression || topic("**");
        this._child = null;
        this._childReady = false;
        this._stopping = false;
        this._udsPath = options.udsPath || path.join(os.tmpdir(), `wearmux-sub-${process.pid}-${randomUUID()}.sock`);
        this._udsServer = null;
        this._udsSocket = null;
    }

    /**
     * Start the UDS server and Python subscriber sidecar, then emit `ready`.
     * @returns {Promise<void>}
     * @throws {Error} If the UDS server or sidecar cannot start.
     */
    async start() {
        if (this._child) return;
        this._stopping = false;

        // Start UDS server first
        await this._startUDSServer();

        // Start Python subscriber sidecar
        await this._startPythonBridge();

        this.emit("ready");
    }

    /**
     * Start the local server that receives MessagePack frames.
     * @private
     * @returns {Promise<void>}
     */
    async _startUDSServer() {
        return new Promise((resolve, reject) => {
            const server = net.createServer((socket) => {
                this._udsSocket = socket;

                // Feed bytes into decodeMultiStream via a Readable — it handles
                // partial/coalesced msgpack frames across chunk boundaries.
                const framing = new Readable({ read() { } });

                socket.on("data", (chunk) => { framing.push(chunk); });
                socket.on("end", () => { framing.push(null); });
                socket.on("error", (err) => {
                    framing.destroy(err);
                    this.emit("error", new Error(`UDS socket error: ${err.message}`));
                });
                socket.on("close", () => {
                    framing.push(null);
                    this._udsSocket = null;
                });

                (async () => {
                    try {
                        for await (const msg of msgpack.decodeMultiStream(framing)) {
                            if (!msg || !msg.key || !msg.payload) continue;
                            let payload = msg.payload;
                            if (typeof payload === "string") {
                                try { payload = JSON.parse(payload); } catch { /* leave as string */ }
                            }
                            this.emit("message", { key: msg.key, payload });
                        }
                    } catch (e) {
                        this.emit("error", new Error(`msgpack decode error: ${e?.message || e}`));
                    }
                })();
            });

            // Clean up stale socket file from a prior crash
            try { require("fs").rmSync(this._udsPath, { force: true }); } catch { }

            server.listen(this._udsPath, () => {
                this._udsServer = server;
                resolve();
            });

            server.on("error", (err) => {
                reject(new Error(`UDS server error: ${err.message}`));
            });
        });
    }

    /**
     * Start the Python subscriber sidecar and wait for readiness.
     * @private
     * @returns {Promise<void>}
     */
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
            if (!this._stopping && code !== 0) {
                this.emit("error", new Error(`Python subscriber exited with code ${code}`));
            }
            this._child = null;
            this._childReady = false;
        });

        // Wait for readiness; reject if the process dies before signalling ready
        await new Promise((resolve, reject) => {
            const onData = (chunk) => {
                if (chunk.toString().includes("[SubscriberBridge] READY")) {
                    cleanup();
                    this._childReady = true;
                    resolve();
                }
            };
            const onExit = (code) => {
                cleanup();
                reject(new Error(`Python subscriber exited before READY (code=${code})`));
            };
            const onError = (err) => {
                cleanup();
                reject(err);
            };
            const cleanup = () => {
                child.stdout.off("data", onData);
                child.off("exit", onExit);
                child.off("error", onError);
            };
            child.stdout.on("data", onData);
            child.once("exit", onExit);
            child.once("error", onError);
        });
    }

    /**
     * Close the UDS server and terminate the owned Python sidecar.
     * @returns {Promise<void>}
     */
    async stop() {
        this._stopping = true;
        try {
            if (this._udsSocket) {
                this._udsSocket.end();
                this._udsSocket.destroy();
                this._udsSocket = null;
            }

            if (this._udsServer) {
                const server = this._udsServer;
                this._udsServer = null;
                await new Promise((resolve) => server.close(resolve));
            }

            if (this._child) {
                this._child.kill("SIGTERM");
                this._child = null;
            }

            this._childReady = false;
        } catch (e) {
            this.emit("error", e);
        } finally {
            try { require("fs").rmSync(this._udsPath, { force: true }); } catch { }
        }
    }
}

/**
 * @event ZenohSubscriber#ready
 * @description Emitted after the UDS server and Python sidecar are ready.
 */
/**
 * @event ZenohSubscriber#message
 * @description Emitted for each decoded MessagePack transport message.
 * @property {TransportMessage} message Transport message.
 */
/**
 * @event ZenohSubscriber#error
 * @description Emitted for sidecar, socket, or MessagePack failures.
 * @property {Error} error The failure.
 */

module.exports = { ZenohSubscriber };
