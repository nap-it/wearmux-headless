const http = require("http");
const os = require("os");
const EventEmitter = require("events");
const { performance } = require("perf_hooks");

const COLOR_MAP = Object.freeze({
    black: "#000000",
    red: "#ff0000",
    green: "#00ff00",
});

function unique(values) {
    return [...new Set(values.filter(Boolean))];
}

function getAdvertisedHosts(bindHost) {
    if (bindHost && bindHost !== "0.0.0.0" && bindHost !== "::") {
        return [bindHost];
    }

    const interfaces = os.networkInterfaces();
    const hosts = ["127.0.0.1", "localhost"];
    for (const entries of Object.values(interfaces)) {
        for (const entry of entries || []) {
            if (!entry || entry.internal) continue;
            if (entry.family === "IPv4") {
                hosts.push(entry.address);
            }
        }
    }

    return unique(hosts);
}

class ColorScreenServer extends EventEmitter {
    constructor(options = {}) {
        super();
        this.options = {
            title: "Latency Color Screen",
            initialColor: "black",
            ...options,
        };
        this.server = null;
        this.host = null;
        this.port = null;
        this.clients = new Set();
        this.primaryViewerId = null;
        this.presentationAcks = new Map();
        this.state = {
            color: this.options.initialColor,
            revision: 0,
            changedAtMs: performance.now(),
            changedAtUnixMs: Date.now(),
        };
    }

    async start(host = "0.0.0.0", port = 8765) {
        if (this.server) {
            throw new Error("Color screen server is already running");
        }

        this.host = host;
        this.port = port;

        await new Promise((resolve, reject) => {
            const server = http.createServer((req, res) => this._handleRequest(req, res));
            server.on("error", reject);
            server.listen(port, host, () => {
                this.server = server;
                resolve();
            });
        });

        return this;
    }

    stop() {
        for (const client of this.clients) {
            try {
                clearInterval(client.keepAliveTimer);
            } catch {}
            try {
                client.res.end();
            } catch {}
        }
        this.clients.clear();

        if (this.server) {
            this.server.close();
            this.server = null;
        }
    }

    get urls() {
        if (!this.server) return [];
        return getAdvertisedHosts(this.host).map((host) => `http://${host}:${this.port}`);
    }

    get viewerCount() {
        return this.clients.size;
    }

    waitForViewer(timeoutMs = 120000) {
        if (this.viewerCount > 0) {
            return Promise.resolve();
        }

        return new Promise((resolve, reject) => {
            let timeoutId = null;
            const onViewer = () => {
                if (this.viewerCount > 0) {
                    cleanup();
                    resolve();
                }
            };
            const cleanup = () => {
                if (timeoutId) clearTimeout(timeoutId);
                this.removeListener("viewer-count-changed", onViewer);
            };

            this.on("viewer-count-changed", onViewer);
            if (timeoutMs > 0) {
                timeoutId = setTimeout(() => {
                    cleanup();
                    reject(new Error(`Timed out waiting for browser viewer after ${timeoutMs}ms`));
                }, timeoutMs);
            }
        });
    }

    waitForPresentation(revision, timeoutMs = 1000) {
        const existingAck = this.presentationAcks.get(revision);
        if (existingAck && (!this.primaryViewerId || existingAck.viewerId === this.primaryViewerId)) {
            return Promise.resolve(existingAck);
        }

        return new Promise((resolve, reject) => {
            let timeoutId = null;
            const eventName = `presentation-ack:${revision}`;
            const onAck = (ack) => {
                if (this.primaryViewerId && ack.viewerId !== this.primaryViewerId) {
                    return;
                }
                cleanup();
                resolve(ack);
            };
            const cleanup = () => {
                if (timeoutId) clearTimeout(timeoutId);
                this.removeListener(eventName, onAck);
            };

            this.on(eventName, onAck);
            if (timeoutMs > 0) {
                timeoutId = setTimeout(() => {
                    cleanup();
                    reject(new Error(`Timed out waiting for browser presentation ack for revision ${revision}`));
                }, timeoutMs);
            }
        });
    }

    setColor(color) {
        this.state = {
            color,
            revision: this.state.revision + 1,
            changedAtMs: performance.now(),
            changedAtUnixMs: Date.now(),
        };
        this._broadcastState();
        return this.state;
    }

    _broadcastState() {
        const payload = `data: ${JSON.stringify(this.state)}\n\n`;
        for (const client of this.clients) {
            try {
                client.res.write(payload);
            } catch {
                this._removeClient(client);
            }
        }
    }

    _removeClient(client) {
        if (!this.clients.has(client)) return;
        this.clients.delete(client);
        try {
            clearInterval(client.keepAliveTimer);
        } catch {}
        if (this.primaryViewerId === client.id) {
            const nextClient = this.clients.values().next().value;
            this.primaryViewerId = nextClient ? nextClient.id : null;
        }
        this.emit("viewer-count-changed", this.viewerCount);
    }

    _addSseClient(req, res, viewerId) {
        res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
            Connection: "keep-alive",
            "Access-Control-Allow-Origin": "*",
        });
        res.write(`data: ${JSON.stringify(this.state)}\n\n`);

        const client = {
            id: viewerId || `viewer-${Date.now()}-${Math.random().toString(16).slice(2)}`,
            req,
            res,
            remoteAddress: req.socket.remoteAddress || null,
            keepAliveTimer: setInterval(() => {
                try {
                    res.write(": keep-alive\n\n");
                } catch {
                    this._removeClient(client);
                }
            }, 15000),
        };

        this.clients.add(client);
        if (!this.primaryViewerId) {
            this.primaryViewerId = client.id;
        }
        this.emit("viewer-count-changed", this.viewerCount);

        req.on("close", () => {
            this._removeClient(client);
        });
    }

    async _readJson(req) {
        const chunks = [];
        for await (const chunk of req) {
            chunks.push(chunk);
        }
        const body = Buffer.concat(chunks).toString("utf8");
        return body ? JSON.parse(body) : {};
    }

    async _handlePresentationAck(req, res) {
        try {
            const payload = await this._readJson(req);
            const revision = Number(payload.revision);
            const viewerId = String(payload.viewerId || "");

            if (!Number.isFinite(revision) || !viewerId) {
                res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
                res.end("Invalid presentation ack");
                return;
            }

            const clientReceivedAtMs = Number(payload.clientReceivedAtMs);
            const clientPresentedAtMs = Number(payload.clientPresentedAtMs);
            const ack = {
                revision,
                viewerId,
                color: payload.color,
                remoteAddress: req.socket.remoteAddress || null,
                receivedAtServerMs: performance.now(),
                clientReceivedAtMs: Number.isFinite(clientReceivedAtMs) ? clientReceivedAtMs : null,
                clientPresentedAtMs: Number.isFinite(clientPresentedAtMs) ? clientPresentedAtMs : null,
                clientPaintDelayMs:
                    Number.isFinite(clientReceivedAtMs) && Number.isFinite(clientPresentedAtMs)
                        ? Math.max(0, clientPresentedAtMs - clientReceivedAtMs)
                        : null,
            };

            this.presentationAcks.set(revision, ack);
            while (this.presentationAcks.size > 128) {
                const oldestRevision = Math.min(...this.presentationAcks.keys());
                this.presentationAcks.delete(oldestRevision);
            }

            this.emit(`presentation-ack:${revision}`, ack);
            this.emit("presentation-ack", ack);

            res.writeHead(204);
            res.end();
        } catch (error) {
            res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
            res.end(error instanceof Error ? error.message : "Invalid presentation ack");
        }
    }

    _handleRequest(req, res) {
        const requestUrl = new URL(req.url, "http://127.0.0.1");
        const { pathname, searchParams } = requestUrl;

        if (req.method === "GET" && (pathname === "/" || pathname === "/index.html")) {
            res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
            res.end(this._getIndexHtml());
            return;
        }

        if (req.method === "GET" && pathname === "/events") {
            this._addSseClient(req, res, searchParams.get("viewerId"));
            return;
        }

        if (req.method === "POST" && pathname === "/ack") {
            this._handlePresentationAck(req, res);
            return;
        }

        if (req.method === "GET" && pathname === "/state") {
            res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
            res.end(
                JSON.stringify({
                    ...this.state,
                    viewerCount: this.viewerCount,
                    primaryViewerId: this.primaryViewerId,
                })
            );
            return;
        }

        if (req.method === "GET" && pathname === "/favicon.ico") {
            res.writeHead(204);
            res.end();
            return;
        }

        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Not found");
    }

    _getIndexHtml() {
        return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <title>${this.options.title}</title>
    <style>
    html, body {
      width: 100%;
      height: 100%;
      margin: 0;
      overflow: hidden;
      background: ${COLOR_MAP[this.state.color] || "#000000"};
      font-family: system-ui, sans-serif;
    }
    body {
      background: ${COLOR_MAP[this.state.color] || "#000000"};
      cursor: pointer;
      user-select: none;
      -webkit-user-select: none;
      -webkit-tap-highlight-color: transparent;
    }
    .overlay {
      position: fixed;
      left: 16px;
      bottom: 16px;
      max-width: min(92vw, 420px);
      padding: 10px 12px;
      border-radius: 10px;
      background: rgba(0, 0, 0, 0.55);
      color: rgba(255, 255, 255, 0.92);
      font-size: 13px;
      line-height: 1.4;
    }
    .hidden {
      display: none;
    }
    .title {
      font-weight: 700;
      margin-bottom: 4px;
    }
    .pill {
      display: inline-block;
      margin: 6px 8px 0 0;
    }
    @media (max-width: 640px) {
      .overlay {
        left: 10px;
        right: 10px;
        bottom: 10px;
        max-width: none;
      }
    }
  </style>
</head>
<body>
  <div class="overlay" id="overlay">
    <div class="title">Latency Color Screen</div>
    <div>Open fullscreen on the display the camera is watching. Tap or press <strong>F</strong> for fullscreen.</div>
    <span class="pill" id="statusText">Connecting…</span>
    <span class="pill" id="colorText">Color: ${this.state.color}</span>
    <span class="pill" id="revisionText">Revision: ${this.state.revision}</span>
  </div>
  <script>
    const colorMap = ${JSON.stringify(COLOR_MAP)};
    const viewerId =
      globalThis.crypto && typeof globalThis.crypto.randomUUID === "function"
        ? globalThis.crypto.randomUUID()
        : "viewer-" + Math.random().toString(16).slice(2);
    const overlay = document.getElementById("overlay");
    const statusText = document.getElementById("statusText");
    const colorText = document.getElementById("colorText");
    const revisionText = document.getElementById("revisionText");

    function applyState(state) {
      const color = colorMap[state.color] || state.color || "#000000";
      document.documentElement.style.background = color;
      document.body.style.background = color;
      colorText.textContent = "Color: " + state.color;
      revisionText.textContent = "Revision: " + state.revision;
    }

    function setConnected(connected) {
      statusText.textContent = connected ? "Connected" : "Reconnecting…";
    }

    function postPresentationAck(state, clientReceivedAtMs, clientPresentedAtMs) {
      fetch("/ack", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        cache: "no-store",
        body: JSON.stringify({
          viewerId,
          revision: state.revision,
          color: state.color,
          clientReceivedAtMs,
          clientPresentedAtMs,
        }),
      }).catch(() => {});
    }

    const source = new EventSource("/events?viewerId=" + encodeURIComponent(viewerId));
    source.onopen = () => setConnected(true);
    source.onmessage = (event) => {
      setConnected(true);
      const state = JSON.parse(event.data);
      const clientReceivedAtMs = performance.now();
      applyState(state);

      const ackPresentation = () => {
        postPresentationAck(state, clientReceivedAtMs, performance.now());
      };

      if (document.hidden) {
        setTimeout(ackPresentation, 0);
      } else if (typeof requestAnimationFrame === "function") {
        requestAnimationFrame(() => {
          ackPresentation();
        });
      } else {
        setTimeout(ackPresentation, 0);
      }
    };
    source.onerror = () => setConnected(false);

    async function tryFullscreen() {
      overlay.classList.add("hidden");
      const element = document.documentElement;
      if (!document.fullscreenElement && element.requestFullscreen) {
        try { await element.requestFullscreen(); } catch {}
      }
    }

    document.body.addEventListener("click", tryFullscreen);
    window.addEventListener("keydown", (event) => {
      if (event.key === "f" || event.key === "F") {
        tryFullscreen();
      }
      if (event.key === "i" || event.key === "I") {
        overlay.classList.toggle("hidden");
      }
    });
  </script>
</body>
</html>`;
    }
}

module.exports = { ColorScreenServer };
