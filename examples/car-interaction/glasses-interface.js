const { DeviceManager } = require("../../utils/device-manager");
const { SensorManager } = require("../../sensors/lib/sensor-manager");
const MLGestureDetector = require("../../sensors/lib/ml-gesture-detector");
const { TextDisplay } = require("../../display/lib/text-display");
const { GLASSES_CONFIG } = require("./constants");

class GlassesInterface {
  constructor(demoMode = false, config = GLASSES_CONFIG) {
    this.demoMode = demoMode;
    this.config = config;

    this.device = null;
    this.textDisplay = null;
    this.sensorManager = null;
    this.mlDetector = null;

    this.isWaitingForGesture = false;

    this.onGestureDetectedCallback = null;
  }

  onGestureDetected(callback) {
    this.onGestureDetectedCallback = callback;
  }

  async initialize() {
    if (this.demoMode) {
      this.device = {
        bluetoothId: "DEMO",
        id: "DEMO",
        name: "Demo Glasses",
      };
      return;
    }

    console.log("Connecting to BrilliantSole Frame...");
    const deviceManager = new DeviceManager();
    this.device = await deviceManager.connectToDevice();
    console.log("Connected to:", this.device.name || this.device.id);

    // Display readiness
    if (!this.device.isDisplayAvailable) {
      console.log("Waiting for display...");
      await this.device.waitForEvent("isDisplayAvailable");
    }
    if (!this.device.isDisplayReady) {
      try { await this.device.waitForEvent("displayReady"); } catch { }
    }
    if (this.device.displayStatus === "asleep") {
      await this.device.wakeDisplay();
    }
    await this.device.setDisplayBrightness("high", true);

    console.log("Initializing text display...");
    this.textDisplay = new TextDisplay(this.device, { fontSize: this.config.DEFAULT_FONT_SIZE });
    await this.textDisplay.loadFont(this.config.DEFAULT_FONT_SIZE);
    console.log("Text display ready");

    // Sensors & ML
    console.log("Initializing ML gesture detector...");
    this.mlDetector = new MLGestureDetector(this.config.ML_WINDOW_SIZE);
    while (!this.mlDetector.initialized) {
      await new Promise(r => setTimeout(r, this.config.ML_INIT_POLL_INTERVAL_MS));
    }
    console.log("ML gesture detector ready");

    console.log("Initializing sensors...");
    this.sensorManager = new SensorManager(this.device, {
      enabledSensors: ["acceleration", "orientation"],
      zenohEnabled: false,
    });
    this.sensorManager.setSensorRate("acceleration", this.config.DEFAULT_SENSOR_RATE);
    this.sensorManager.setSensorRate("orientation", this.config.DEFAULT_SENSOR_RATE);

    this._setupSensorFeed();
    await this.sensorManager.startSensors();
    console.log("Sensors ready");

    this.mlDetector.on("ml-gesture", (result) => this._processMLResult(result));
  }

  _setupSensorFeed() {
    let latestAcc = null;
    this.sensorManager.on("acceleration", (event) => {
      if (event?.message?.acceleration) {
        latestAcc = event.message.acceleration;
      }
    });

    this.sensorManager.on("orientation", (event) => {
      if (event?.message?.orientation && latestAcc) {
        if (this.isWaitingForGesture) {
          const orient = event.message.orientation;
          this.mlDetector.addSample({
            accX: latestAcc.x,
            accY: latestAcc.y,
            accZ: latestAcc.z,
            heading: orient.heading,
            pitch: orient.pitch,
            roll: orient.roll,
          });
        }
      }
    });
  }

  _processMLResult(result) {
    if (!this.isWaitingForGesture || !this.onGestureDetectedCallback) return;

    if (process.env.DEBUG === "1" && result?.results) {
      const top = result.results.reduce((a, b) => (a.value > b.value ? a : b));
      console.log(`   [DEBUG] ML: ${top?.label} ${(top?.value * 100)?.toFixed(1)}%`);
    }

    const sorted = (result?.results || [])
      .filter(r => r.label && r.label.toLowerCase() !== "idle")
      .sort((a, b) => b.value - a.value);

    if (sorted.length === 0) return;

    const topGesture = sorted[0];
    let confidenceThreshold = this.config.DEFAULT_GESTURE_CONFIDENCE;

    const label = topGesture.label.toLowerCase();
    if (label === 'nod' || label === 'yes') {
      confidenceThreshold = this.config.DEFAULT_NOD_CONFIDENCE;
    } else if (label === 'shake' || label === 'no') {
      confidenceThreshold = this.config.DEFAULT_SHAKE_CONFIDENCE;
    }

    if (topGesture.value < confidenceThreshold) return;

    const mappedGesture = (label === "yes" || label === "nod") ? "nod" : (label === "no" || label === "shake") ? "shake" : label;
    console.log(`Gesture detected: ${mappedGesture} (${(topGesture.value * 100).toFixed(1)}%)`);

    this.onGestureDetectedCallback(mappedGesture);
  }

  startWaitingForGesture() {
    this.isWaitingForGesture = true;
    if (!this.demoMode && this.mlDetector) {
      this.mlDetector.reset();
    }
  }

  stopWaitingForGesture() {
    this.isWaitingForGesture = false;
  }

  async showMessage(text, options = {}) {
    if (this.demoMode || !this.textDisplay) return;
    try {
      await this.textDisplay.showText(text, {
        align: "center",
        valign: "middle",
        ...options
      });
    } catch (err) {
      console.error("Display error:", err.message);
    }
  }

  async clearDisplay() {
    if (this.demoMode || !this.textDisplay) return;
    try {
      await this.textDisplay.clear();
    } catch (err) {
      console.error("Display clear error:", err.message);
    }
  }

  waitForDemoGesture() {
    return new Promise((resolve) => {
      if (!process.stdin.isTTY) {
        setTimeout(() => resolve("timeout"), this.config.DEFAULT_GESTURE_TIMEOUT_MS);
        return;
      }

      const timeout = setTimeout(() => {
        cleanup();
        resolve("timeout");
      }, this.config.DEFAULT_GESTURE_TIMEOUT_MS);

      const cleanup = () => {
        clearTimeout(timeout);
        process.stdin.removeListener("data", onData);
        if (process.stdin.isTTY) process.stdin.setRawMode(false);
      };

      const onData = (key) => {
        const k = key.toString().toLowerCase();
        if (k === "y") {
          cleanup();
          resolve("nod");
        } else if (k === "n") {
          cleanup();
          resolve("shake");
        }
      };

      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", onData);
    });
  }

  async cleanup() {
    if (this.textDisplay && !this.demoMode) {
      await this.textDisplay.clear().catch(e => console.error(e));
    }
    // Additional unbinds or teardown can happen here if DeviceManager isn't managing it
  }
}

module.exports = { GlassesInterface };
