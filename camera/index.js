const fs = require("fs");
const path = require("path");
const { CameraManager } = require("./lib/camera-manager");
const { Config } = require("../utils/config");

async function ensureDir(dir) {
    await fs.promises.mkdir(dir, { recursive: true });
}

async function main() {
    const config = Config.getAllConfig();
    const outDir = config.camera.outputDir; // optional
    const auto = config.camera.autoPicture;
    const imgFmt = config.camera.imageFormat;
    const quality = config.camera.quality;
    const resolution = config.camera.resolution;
    const qualityFactor = config.camera.qualityFactor ?? quality; // maintain backwards compat
    const shutter = config.camera.shutter;
    const gain = config.camera.gain;
    const redGain = config.camera.redGain;
    const greenGain = config.camera.greenGain;
    const blueGain = config.camera.blueGain;

    if (outDir) await ensureDir(outDir);

    // Optional viewer settings
    const viewEnable = config.camera.viewEnable;
    const viewPort = config.camera.viewPort || 8099;
    const viewHost = config.camera.viewHost || "127.0.0.1";
    const viewMjpeg = config.camera.viewMjpeg;
    let latestImage = null;
    let viewerServer = null;

    const cam = new CameraManager({
        auto,
        imageFormat: imgFmt,
        resolution,
        qualityFactor,
        shutter,
        gain,
        redGain,
        greenGain,
        blueGain,
    });

    cam.on("error", (err) => {
        console.error("Camera error:", err);
    });

    let counter = 0;
    let firstImageResolve;
    const firstImagePromise = new Promise((resolve) => (firstImageResolve = resolve));
    cam.on("image", async ({ buffer, format }) => {
        try {
            const ts = new Date().toISOString().replace(/[:.]/g, "-");
            const fname = `bsole-${ts}-${(counter++).toString().padStart(4, "0")}.${format}`;
            if (outDir) {
                const file = path.join(outDir, fname);
                await fs.promises.writeFile(file, buffer);
                console.log("saved:", file, buffer.length, "bytes");
            } else {
                // If no outputDir, still log receipt for debugging
                console.log("image received:", buffer.length, "bytes");
            }
            latestImage = { buffer, mime: formatToMime(format) };
            if (viewerServer && typeof viewerServer.pushFrame === 'function') {
                viewerServer.pushFrame(latestImage);
            }
            try { firstImageResolve(); } catch {}
        } catch (e) {
            console.error("Failed to save image:", e);
        }
    });

    try {
    await cam.start();
    console.log(`Camera ready. Auto=${auto}. ${outDir ? `Output -> ${outDir}` : 'No file output (set CAMERA_OUTPUT_DIR to save images)'}`);

        if (viewEnable) {
            viewerServer = startViewerServer(viewHost, viewPort, () => latestImage, { mjpeg: viewMjpeg });
            console.log(`Viewer at http://${viewHost}:${viewPort}`);
        }

        if (!auto) {
            // If not auto, take one picture and exit
            const res = await cam.takePicture();
            // wait up to 5s for event-based delivery
            await Promise.race([
                firstImagePromise,
                new Promise((r) => setTimeout(r, 5000)),
            ]);
            // Exit after first photo written (allow a small delay for write)
            setTimeout(async () => {
                await cam.close();
                if (viewerServer) try { viewerServer.close(); } catch {}
                process.exit(0);
            }, 500);
        } else {
            // Keep process alive for auto-capture until SIGINT
            process.on("SIGINT", async () => {
                console.log("\nShutting down camera...");
                await cam.close();
                if (viewerServer) try { viewerServer.close(); } catch {}
                process.exit(0);
            });
        }
    } catch (err) {
        console.error("Failed to start camera capture:", err);
        process.exit(1);
    }
}

if (require.main === module) {
    main().catch((e) => {
        console.error(e);
        process.exit(1);
    });
}

module.exports = main;

function formatToMime(fmt) {
    const f = String(fmt || "").toLowerCase();
    if (f === "jpg" || f === "jpeg") return "image/jpeg";
    if (f === "png") return "image/png";
    if (f === "bmp") return "image/bmp";
    return "application/octet-stream";
}

function startViewerServer(host, port, getLatest, opts = {}) {
    const http = require("http");
    const clients = new Set(); // for MJPEG
    const server = http.createServer((req, res) => {
        if (req.url === "/" || req.url === "/index.html") {
            const html = `<!doctype html><html><head><meta charset="utf-8"><title>Camera</title></head><body style="margin:0;background:#111;color:#eee;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;gap:8px;">
            <div style="font:12px sans-serif;opacity:.7;">${opts.mjpeg ? 'Using MJPEG stream' : 'Using polling /latest'}</div>
            <img id="img" style="max-width:100%;max-height:100vh;image-rendering:auto;display:none;"/>
            <div id="status" style="font:14px sans-serif;opacity:.6;">Waiting for first image…</div><script>
            const img=document.getElementById('img');
            const status=document.getElementById('status');
            ${opts.mjpeg ? `img.src='/stream.mjpg'; img.style.display='block'; status.style.display='none';` : `
            async function tick(){
              try{
                const r=await fetch('/latest?_=' + Date.now());
                if(r.status===200){
                  const b=await r.blob(); const url=URL.createObjectURL(b);
                  img.src=url; img.style.display='block'; status.style.display='none';
                }
              }catch(e){}
            }
            setInterval(tick, 200); tick();`}
            </script></body></html>`;
            res.writeHead(200, { "Content-Type": "text/html" });
            res.end(html);
            return;
        }
        if (opts.mjpeg && req.url === "/stream.mjpg") {
            const boundary = "--bsoleboundary";
            res.writeHead(200, {
                "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
                "Pragma": "no-cache",
                "Content-Type": "multipart/x-mixed-replace; boundary=" + boundary
            });
            clients.add(res);
            req.on('close', () => { try { res.end(); } catch {}; clients.delete(res); });
            return;
        }
        if (req.url && req.url.startsWith("/latest")) {
            const cur = getLatest && getLatest();
            if (!cur) {
                res.writeHead(204);
                res.end();
                return;
            }
            res.writeHead(200, { "Content-Type": cur.mime, "Cache-Control": "no-store" });
            res.end(cur.buffer);
            return;
        }
        res.writeHead(404);
        res.end();
    });
    // Push frames to MJPEG clients when a new image arrives
    server.pushFrame = (img) => {
        if (!opts.mjpeg || !img) return;
        const boundary = "--bsoleboundary";
        for (const res of clients) {
            try {
                res.write(`${boundary}\r\nContent-Type: ${img.mime}\r\nContent-Length: ${img.buffer.length}\r\n\r\n`);
                res.write(img.buffer);
                res.write("\r\n");
            } catch { clients.delete(res); }
        }
    };
    server.listen(port, host);
    return server;
}
