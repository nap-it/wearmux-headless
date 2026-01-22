const fs = require("fs");
const path = require("path");
const { Config } = require("../utils/config");
const { DeviceManager } = require("../utils/device-manager");

async function ensureDir(dir) {
    await fs.promises.mkdir(dir, { recursive: true });
}

async function getDevice() {
    const deviceManager = new DeviceManager();
    const device = await deviceManager.connectToDevice();
    return device;
}

async function main() {
    const config = Config.getAllConfig();
    const outDir = config.camera.outputDir;
    const auto = config.camera.autoPicture;
    const imgFmt = config.camera.imageFormat;
    const quality = config.camera.quality;
    const resolution = config.camera.resolution;
    const qualityFactor = config.camera.qualityFactor ?? quality;
    const shutter = config.camera.shutter;
    const gain = config.camera.gain;
    const redGain = config.camera.redGain;
    const greenGain = config.camera.greenGain;
    const blueGain = config.camera.blueGain;
    const debug = process.env.DEBUG === "1" || process.env.CAMERA_DEBUG === "1";

    if (outDir) await ensureDir(outDir);

    const viewEnable = config.camera.viewEnable;
    const viewPort = config.camera.viewPort || 8099;
    const viewHost = config.camera.viewHost || "127.0.0.1";
    const viewMjpeg = config.camera.viewMjpeg;
    let latestImage = null;
    let viewerServer = null;

    try {
        const device = await getDevice();
        console.log(`Connected to device: ${device.name || device.id}`);

        if (!device.hasCamera) {
            throw new Error("Device does not have a camera");
        }
        console.log("[OK] Device has camera");

        await new Promise((resolve) => {
            if (device.connectionStatus === 'connected') {
                resolve();
            } else {
                const handler = () => {
                    device.removeEventListener('connected', handler);
                    resolve();
                };
                device.addEventListener('connected', handler);
            }
        });

        console.log("Configuring camera...");
        
        const cameraConfig = {
            resolution: resolution || 640,
            qualityFactor: qualityFactor !== undefined ? qualityFactor : 95,
        };
        
        if (shutter !== undefined) cameraConfig.shutter = shutter;
        if (gain !== undefined) cameraConfig.gain = gain;
        if (redGain !== undefined) cameraConfig.redGain = redGain;
        if (greenGain !== undefined) cameraConfig.greenGain = greenGain;
        if (blueGain !== undefined) cameraConfig.blueGain = blueGain;
        
        console.log("Camera config:", cameraConfig);
        await device.setCameraConfiguration(cameraConfig);

        console.log("Camera status:", device.cameraStatus);
        if (device.cameraStatus === 'asleep') {
            console.log("Waking camera...");
            await device.wakeCamera();
            await new Promise(r => setTimeout(r, 1000));
        }

        console.log("Waiting for camera to stabilize...");
        await new Promise(r => setTimeout(r, 2000));

        let counter = 0;
        let savedCount = 0;
        let isProcessingImage = false;
        let lastSavedTimestamp = null;
        let firstImageResolve;
        const firstImagePromise = new Promise((resolve) => (firstImageResolve = resolve));
        
        let pendingImages = [];
        let imageCollectionTimeout = null;

        function isValidJpeg(buffer) {
            if (!buffer || buffer.length < 2) return false;
            return buffer[0] === 0xFF && buffer[1] === 0xD8;
        }

        function debugLog(...args) {
            if (debug) console.log(...args);
        }

        let isSavingBestImage = false;
        const saveBestImage = async () => {
            if (isSavingBestImage || pendingImages.length === 0 || savedCount >= 1) {
                return;
            }
            
            isSavingBestImage = true;
            
            if (imageCollectionTimeout) {
                clearTimeout(imageCollectionTimeout);
                imageCollectionTimeout = null;
            }
            
            pendingImages.sort((a, b) => b.size - a.size);
            const bestImage = pendingImages[0];
            
            debugLog(`[INFO] Collected ${pendingImages.length} image(s), saving largest (${bestImage.size} bytes)`);
            
            const ts = new Date().toISOString().replace(/[:.]/g, "-");
            const fname = `bsole-${ts}-${(counter++).toString().padStart(4, "0")}.${imgFmt}`;
            
            if (outDir) {
                const file = path.join(outDir, fname);
                await fs.promises.writeFile(file, bestImage.buffer);
                console.log("[SAVED]", file, bestImage.buffer.length, "bytes");
            }
            
            latestImage = { buffer: bestImage.buffer, mime: formatToMime(imgFmt) };
            if (viewerServer && typeof viewerServer.pushFrame === 'function') {
                viewerServer.pushFrame(latestImage);
            }
            
            savedCount += 1;
            lastSavedTimestamp = bestImage.timestamp || null;
            pendingImages = [];
            isSavingBestImage = false;
            
            debugLog("[REMOVE] Removing cameraImage listener (non-auto mode, image saved)");
            device.removeEventListener('cameraImage', imageHandler);
            
            try { firstImageResolve(); } catch {}
        };

        const imageHandler = async (event) => {
            try {
                const cameraImage = event.message;
                if (!cameraImage) {
                    console.error("Invalid camera image event:", event);
                    return;
                }

                debugLog("[IMAGE] Image event received:", {
                    hasBlob: !!cameraImage.blob,
                    hasUrl: !!cameraImage.url,
                    hasArrayBuffer: !!cameraImage.arrayBuffer,
                    timestamp: cameraImage.timestamp,
                    latency: cameraImage.latency,
                    blobSize: cameraImage.blob?.size,
                    blobType: cameraImage.blob?.type
                });

                if (!auto && savedCount >= 1) {
                    debugLog("[SKIP] Skipping extra image (non-auto mode, already saved one)");
                    return;
                }
                
                if (!auto && imageCollectionTimeout) {
                    clearTimeout(imageCollectionTimeout);
                }
                
                isProcessingImage = true;
                
                let buffer;
                if (cameraImage.url) {
                    debugLog(`[IMAGE] Image URL: ${cameraImage.url}`);
                    if (cameraImage.blob) {
                        buffer = Buffer.from(await cameraImage.blob.arrayBuffer());
                    } else if (cameraImage.arrayBuffer) {
                        buffer = Buffer.from(cameraImage.arrayBuffer);
                    } else {
                        console.error("[ERROR] No blob or arrayBuffer in camera image event");
                        isProcessingImage = false;
                        return;
                    }
                } else if (cameraImage.blob) {
                    buffer = Buffer.from(await cameraImage.blob.arrayBuffer());
                } else if (cameraImage.arrayBuffer) {
                    buffer = Buffer.from(cameraImage.arrayBuffer);
                } else {
                    console.error("[ERROR] Neither URL, blob, nor arrayBuffer in camera image event");
                    isProcessingImage = false;
                    return;
                }

                debugLog(`[BUFFER] Buffer extracted: size=${buffer.length} bytes, first 16 bytes: ${buffer.slice(0, 16).toString('hex')}`);

                if (!buffer || buffer.length === 0) {
                    debugLog("[SKIP] Skipping empty image buffer");
                    isProcessingImage = false;
                    return;
                }

                if (buffer.length < 100) {
                    debugLog(`[SKIP] Skipping suspiciously small image (${buffer.length} bytes - likely invalid)`);
                    isProcessingImage = false;
                    return;
                }

                if (!isValidJpeg(buffer)) {
                    debugLog(`[SKIP] Skipping invalid JPEG (size=${buffer.length}, first bytes: ${buffer.slice(0, 4).toString('hex')})`);
                    isProcessingImage = false;
                    return;
                }

                const hasValidStructure = buffer.length >= 4 && (
                    (buffer[2] === 0xFF && buffer[3] === 0xE0) ||
                    (buffer[2] === 0xFF && buffer[3] === 0xE1) ||
                    (buffer[2] === 0xFF && buffer[3] === 0xDB) ||
                    (buffer[2] === 0xFF && buffer[3] === 0xC0) ||
                    (buffer[2] === 0xFF && buffer[3] === 0xC4)
                );
                
                if (!hasValidStructure) {
                    debugLog(`[SKIP] Skipping JPEG with invalid structure (bytes 2-3: ${buffer.slice(2, 4).toString('hex')})`);
                    isProcessingImage = false;
                    return;
                }
                
                debugLog(`[VALID] Valid image: size=${buffer.length} bytes, blob type=${cameraImage.blob?.type || 'N/A'}, timestamp=${cameraImage.timestamp || 'N/A'}, latency=${cameraImage.latency || 'N/A'}ms`);
                
                // Device sends two images per takePicture() - collect and save the largest
                if (!auto) {
                    if (savedCount >= 1) {
                        debugLog("[SKIP] Skipping image (already saved in non-auto mode)");
                        isProcessingImage = false;
                        return;
                    }
                    
                    pendingImages.push({
                        buffer,
                        size: buffer.length,
                        timestamp: cameraImage.timestamp,
                        latency: cameraImage.latency
                    });
                    
                    debugLog(`[COLLECT] Collected image ${pendingImages.length} (${buffer.length} bytes). Waiting for more...`);
                    
                    if (imageCollectionTimeout) {
                        clearTimeout(imageCollectionTimeout);
                        imageCollectionTimeout = null;
                    }
                    
                    imageCollectionTimeout = setTimeout(async () => {
                        await saveBestImage();
                        isProcessingImage = false;
                    }, 300);
                    
                    isProcessingImage = false;
                } else {
                    const ts = new Date().toISOString().replace(/[:.]/g, "-");
                    const fname = `bsole-${ts}-${(counter++).toString().padStart(4, "0")}.${imgFmt}`;
                    
                    if (outDir) {
                        const file = path.join(outDir, fname);
                        await fs.promises.writeFile(file, buffer);
                        console.log("[SAVED]", file, buffer.length, "bytes");
                    } else {
                        debugLog("[RECEIVED] image received:", buffer.length, "bytes");
                    }
                    
                    latestImage = { buffer, mime: formatToMime(imgFmt) };
                    if (viewerServer && typeof viewerServer.pushFrame === 'function') {
                        viewerServer.pushFrame(latestImage);
                    }
                    
                    savedCount += 1;
                    lastSavedTimestamp = cameraImage.timestamp || null;
                    isProcessingImage = false;
                }
            } catch (e) {
                console.error("[ERROR] Failed to save image:", e);
                isProcessingImage = false;
            }
        };

        device.addEventListener('cameraImage', imageHandler);

        console.log(`Camera ready. Auto=${auto}. ${outDir ? `Output -> ${outDir}` : 'No file output (set CAMERA_OUTPUT_DIR to save images)'}`);

        if (viewEnable) {
            viewerServer = startViewerServer(viewHost, viewPort, () => latestImage, { mjpeg: viewMjpeg });
            console.log(`Viewer at http://${viewHost}:${viewPort}`);
        }

        if (!auto) {
            console.log("Focusing camera first...");
            await device.focusCamera();
            await new Promise(r => setTimeout(r, 2000));
            
            console.log("Taking picture...");
            await device.takePicture();
            
            await Promise.race([
                firstImagePromise,
                new Promise((r) => setTimeout(r, 5000)),
            ]);
            
            setTimeout(async () => {
                await device.disconnect();
                if (viewerServer) try { viewerServer.close(); } catch {}
                process.exit(0);
            }, 500);
        } else {
            console.log("Starting auto-capture mode (Ctrl+C to stop)...");
            device.autoPicture = true;

            process.on("SIGINT", async () => {
                console.log("\nShutting down camera...");
                device.autoPicture = false;
                await device.disconnect();
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
    const clients = new Set();
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
