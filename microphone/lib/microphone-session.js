const { calculateRMS, calculatePeak } = require("./audio-utils");
const { RtspPublisher } = require("./rtsp-publisher");
const { topic } = require("../../utils/topics");
const { publishRawMedia } = require("../../utils/raw-media");

/**
 * Acquire one device's audio, report levels, and optionally publish raw samples
 * and an RTSP stream. The owner supplies the connected device and shared publisher.
 * Raw batches are ordered; packets arriving while a batch is in flight are skipped.
 * @class
 * @see DeviceSession
 * @see {@tutorial microphone}
 */
class MicrophoneSession {
    /**
     * @param {Object} device Connected SDK device with microphone capabilities.
     * @param {?Publisher} publisher Started publisher, or null for local monitoring.
     * @param {Object} options Session identity and optional local callbacks.
     * @param {DeviceIdentity} options.deviceInfo Source identity for outgoing messages.
     * @param {number} [options.microphoneIndex=0] RTSP suffix index; zero uses the base URL.
     * @param {function(MicrophoneLevel):void} [options.onLevel] Synchronous level callback.
     * @param {function(string):void} [options.onStatus] Synchronous SDK status callback.
     */
    constructor(device, publisher, options = {}) {
        this.device = device;
        this.publisher = publisher;
        this.deviceInfo = options.deviceInfo;
        this.onLevel = options.onLevel || null;
        this.onMicrophoneStatus = options.onStatus || null;
        this.microphoneIndex = options.microphoneIndex || 0;
        this.running = false;
        this.lastRawAt = 0;
        this.rawPending = Promise.resolve();
        this.rawBusy = false;
        this.onData = (event) => this.receiveData(event).catch((error) =>
            console.warn(`[Microphone][${this.deviceInfo.id}]`, error?.message || error));
        this.onStatus = (event) => {
            const status = event.message?.microphoneStatus;
            this.onMicrophoneStatus?.(status);
            this.publish(topic("microphone", "status"), {
                ts: Date.now(), device: this.deviceInfo, microphoneStatus: status,
            });
        };
    }

    /**
     * Attach listeners and start the device microphone using environment settings.
     * Repeated calls while running have no effect. SDK setup failures reject after
     * cleanup; unavailable RTSP is logged and acquisition continues without it.
     * @returns {Promise<void>}
     */
    async start() {
        if (this.running) return;
        this.running = true;
        try {
            const baseRtspUrl = process.env.RTSP_URL;
            if (baseRtspUrl && process.env.RTSP_ENABLE !== "0") {
                // Give additional microphone sessions distinct RTSP paths on the same server.
                const rtspUrl = new URL(baseRtspUrl);
                if (this.microphoneIndex > 0) rtspUrl.pathname += `-${this.microphoneIndex}`;
                this.rtsp = new RtspPublisher({
                    rtspUrl: rtspUrl.toString(),
                    ffmpegPath: process.env.FFMPEG_PATH || "ffmpeg",
                    ffmpegLogLevel: process.env.FFMPEG_LOGLEVEL || "error",
                    sampleRate: Number(process.env.SAMPLE_RATE || 16000),
                    channels: Math.max(1, Number(process.env.CHANNELS || 1)),
                    sampleFormat: process.env.SAMPLE_FORMAT || "s16le",
                    audioBitrate: process.env.AUDIO_BITRATE || "64k",
                });
                this.rtsp.on("error", (error) => console.warn(`[Microphone][${this.deviceInfo.id}] RTSP:`, error.message));
                try {
                    await this.rtsp.start();
                    console.log(`[Microphone][${this.deviceInfo.id}] RTSP ${rtspUrl}`);
                } catch (error) {
                    console.warn(`[Microphone][${this.deviceInfo.id}] RTSP unavailable:`, error?.message || error);
                    await this.rtsp.stop().catch(() => {});
                    this.rtsp = null;
                }
            }
            this.device.addEventListener("microphoneData", this.onData);
            this.device.addEventListener("microphoneStatus", this.onStatus);
            await this.configure();
        } catch (error) {
            await this.stop();
            throw error;
        }
    }

    /** @private */
    async configure() {
        await this.device.setMicrophoneConfiguration({
            sampleRate: String(process.env.SAMPLE_RATE || 16000),
            bitDepth: String(process.env.BIT_DEPTH || 16),
        });
        await this.device.setSensorConfiguration({ microphone: 5 }, false);
        await this.device.startMicrophone();
        await this.publish(topic("microphone", "status"), {
            ts: Date.now(), device: this.deviceInfo, status: "connected",
        });
    }

    /** @private */
    async receiveData(event) {
        if (!this.running) return;
        const { samples, sampleRate, bitDepth } = event.message || {};
        if (!samples?.length) return;
        const rms = calculateRMS(samples);
        const peak = calculatePeak(samples);
        const meta = {
            ts: Date.now(), device: this.deviceInfo, sampleRate, bitDepth, rms, peak,
            db: rms > 0 ? (20 * Math.log10(rms)).toFixed(1) : "-∞", samples: samples.length,
        };
        this.onLevel?.(meta);
        this.publish(topic("microphone", "level"), meta);
        if (this.publisher && process.env.MIC_RAW_ENABLE === "1") {
            const throttleMs = Math.max(0, Number(process.env.MIC_RAW_THROTTLE_MS || 200));
            if (!this.rawBusy && Date.now() - this.lastRawAt >= throttleMs) {
                this.lastRawAt = Date.now();
                this.rawBusy = true;
                // Keep metadata and chunks for a frame in order on the shared publisher.
                // Copy the view before publishing; the SDK may reuse its audio buffer for the next packet.
                const snapshot = Buffer.from(new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength));
                this.rawPending = publishRawMedia(this.publisher, "microphone", snapshot, {
                    device: this.deviceInfo, format: "f32le", sampleRate, bitDepth, samples: samples.length,
                }).catch((error) =>
                    console.warn(`[Microphone][${this.deviceInfo.id}] raw:`, error?.message || error))
                    .finally(() => { this.rawBusy = false; });
            }
        }
        if (this.rtsp) {
            try { await this.rtsp.write(samples); }
            catch (error) {
                console.warn(`[Microphone][${this.deviceInfo.id}] RTSP stopped:`, error?.message || error);
                await this.rtsp.stop().catch(() => {});
                this.rtsp = null;
            }
        }
    }

    /** @private */
    async publish(key, data) {
        if (!this.publisher) return;
        try { await this.publisher.publish(key, data); }
        catch (error) { console.warn(`[Microphone][${this.deviceInfo.id}] publish:`, error?.message || error); }
    }

    /**
     * Restore microphone configuration after the owner reconnects the device.
     * Has no effect when stopped; configuration errors reject.
     * @returns {Promise<void>}
     */
    async resume() {
        if (this.running) await this.configure();
    }

    /**
     * Detach listeners, request microphone stop, finish an in-flight raw batch,
     * and stop the owned RTSP process. Does not disconnect the device or shared
     * publisher. A device stop failure is logged rather than rethrown.
     * @returns {Promise<void>}
     */
    async stop() {
        this.running = false;
        this.device.removeEventListener?.("microphoneData", this.onData);
        this.device.removeEventListener?.("microphoneStatus", this.onStatus);
        if (this.device.isConnected !== false) {
            try { await this.device.stopMicrophone(); } catch (error) {
                console.warn(`[Microphone][${this.deviceInfo.id}] stop:`, error?.message || error);
            }
        }
        // Let any in-flight raw audio batch finish before its shared publisher is closed.
        await this.rawPending;
        await this.rtsp?.stop();
        this.rtsp = null;
    }
}

module.exports = { MicrophoneSession };
