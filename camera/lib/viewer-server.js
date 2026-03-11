/**
 * HTTP server for viewing camera images in a browser
 * Supports both polling mode (refresh) and MJPEG streaming
 */

const http = require("http");

class ViewerServer {
    constructor(options = {}) {
        this.options = {
            mjpeg: options.mjpeg || false,
            ...options
        };
        this.server = null;
        this.clients = new Set();
        this.latestImage = null;
        this.getLatestCallback = null;
        this.host = null;
        this.port = null;
    }

    /**
     * Start the HTTP server
     * @param {string} host - Host to bind to (default: 127.0.0.1)
     * @param {number} port - Port to listen on (default: 8099)
     * @param {Function} getLatest - Callback to get latest image
     */
    start(host = "0.0.0.0", port = 8099, getLatest = null) {
        if (this.server) {
            throw new Error("Server is already running");
        }

        this.host = host;
        this.port = port;
        this.getLatestCallback = getLatest || (() => this.latestImage);

        this.server = http.createServer((req, res) => this._handleRequest(req, res));
        this.server.listen(port, host);

        return this;
    }

    /**
     * Stop the HTTP server
     */
    stop() {
        if (this.server) {
            this.server.close();
            this.server = null;
        }
        
        // Close all client connections
        for (const client of this.clients) {
            try {
                client.end();
            } catch (e) {
                // Ignore errors on close
            }
        }
        this.clients.clear();
    }

    /**
     * Update the latest image
     * @param {Buffer} buffer - Image buffer
     * @param {string} mime - MIME type
     */
    updateImage(buffer, mime) {
        this.latestImage = { buffer, mime };
        
        // If MJPEG mode, push to all connected clients
        if (this.options.mjpeg && this.clients.size > 0) {
            this.pushFrame(this.latestImage);
        }
    }

    /**
     * Push a frame to all MJPEG clients
     * @param {Object} image - Image object with buffer and mime
     */
    pushFrame(image) {
        if (!this.options.mjpeg || !image) return;
        
        const boundary = "--bsoleboundary";
        const header = `${boundary}\r\nContent-Type: ${image.mime}\r\nContent-Length: ${image.buffer.length}\r\n\r\n`;
        
        for (const client of this.clients) {
            try {
                client.write(header);
                client.write(image.buffer);
                client.write("\r\n");
            } catch (e) {
                // Remove dead clients
                this.clients.delete(client);
            }
        }
    }

    /**
     * Get the server URL
     */
    get url() {
        if (!this.server) return null;
        return `http://${this.host}:${this.port}`;
    }

    /**
     * Check if server is running
     */
    get isRunning() {
        return this.server !== null;
    }

    /**
     * Handle HTTP requests
     * @private
     */
    _handleRequest(req, res) {
        // Index page
        if (req.url === "/" || req.url === "/index.html") {
            res.writeHead(200, { "Content-Type": "text/html" });
            res.end(this._getIndexHtml());
            return;
        }

        // MJPEG stream endpoint
        if (this.options.mjpeg && req.url === "/stream.mjpg") {
            const boundary = "--bsoleboundary";
            res.writeHead(200, {
                "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
                "Pragma": "no-cache",
                "Content-Type": `multipart/x-mixed-replace; boundary=${boundary}`
            });
            
            this.clients.add(res);
            
            req.on('close', () => {
                try {
                    res.end();
                } catch (e) {
                    // Ignore errors
                }
                this.clients.delete(res);
            });
            return;
        }

        // Latest image endpoint (for polling mode)
        if (req.url && req.url.startsWith("/latest")) {
            const current = this.getLatestCallback && this.getLatestCallback();
            if (!current) {
                res.writeHead(204);
                res.end();
                return;
            }
            res.writeHead(200, {
                "Content-Type": current.mime,
                "Cache-Control": "no-store"
            });
            res.end(current.buffer);
            return;
        }

        // 404 for everything else
        res.writeHead(404);
        res.end();
    }

    /**
     * Generate HTML for the viewer page
     * @private
     */
    _getIndexHtml() {
        const mode = this.options.mjpeg ? 'MJPEG stream' : 'polling /latest';
        const imgScript = this.options.mjpeg
            ? `img.src='/stream.mjpg'; img.style.display='block'; status.style.display='none';`
            : `
            async function tick(){
              try{
                const r=await fetch('/latest?_=' + Date.now());
                if(r.status===200){
                  const b=await r.blob(); const url=URL.createObjectURL(b);
                  img.src=url; img.style.display='block'; status.style.display='none';
                }
              }catch(e){}
            }
            setInterval(tick, 200); tick();`;

        return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Camera Viewer</title>
  <style>
    body {
      margin: 0;
      background: #111;
      color: #eee;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      gap: 8px;
      font-family: sans-serif;
    }
    .info {
      font-size: 12px;
      opacity: 0.7;
    }
    #img {
      max-width: 100%;
      max-height: 100vh;
      image-rendering: auto;
      display: none;
    }
    #status {
      font-size: 14px;
      opacity: 0.6;
    }
  </style>
</head>
<body>
  <div class="info">Using ${mode}</div>
  <img id="img" />
  <div id="status">Waiting for first image…</div>
  <script>
    const img = document.getElementById('img');
    const status = document.getElementById('status');
    ${imgScript}
  </script>
</body>
</html>`;
    }
}

module.exports = { ViewerServer };
