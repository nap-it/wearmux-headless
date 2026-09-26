// Edge Impulse's generated loader expects Module options before it executes.
// Inject them without modifying the pinned upstream runtime or global fetch.
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");

const MODEL_FILE = path.resolve(__dirname, "../../model/brilliantwear-glasses/edge-impulse-standalone.js");
let runtime = null;
let initializationPromise = null;

function initialize() {
    return new Promise((resolve, reject) => {
        let settled = false;
        let diagnostic = "";
        const modelIntervals = new Set();
        const clearModelIntervals = () => {
            for (const interval of modelIntervals) clearInterval(interval);
            modelIntervals.clear();
        };
        const fail = (reason) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            clearModelIntervals();
            const detail = String(reason?.message || reason || diagnostic).slice(0, 500);
            reject(new Error(`Edge Impulse model initialization failed: ${detail}`));
        };
        const timer = setTimeout(() => fail("timed out after 10 seconds"), 10000);

        try {
            const binary = fs.readFileSync(MODEL_FILE.replace(/\.js$/, ".wasm"));
            const options = {
                wasmBinary: binary,
                print: () => {},
                printErr: (message) => { diagnostic = String(message).slice(0, 500); },
                onAbort: fail,
                // Own the async promise so a corrupt binary rejects init() instead
                // of causing an unhandled rejection in this older generated loader.
                instantiateWasm: (imports, receiveInstance) => {
                    WebAssembly.instantiate(binary, imports)
                        .then(({ instance }) => { if (!settled) receiveInstance(instance); })
                        .catch(fail);
                    return {};
                },
                onRuntimeInitialized: () => {
                    if (settled) return;
                    try {
                        const code = options.init();
                        if (typeof code === "number" && code !== 0) {
                            throw new Error(`init() returned ${code}`);
                        }
                        runtime = options;
                        settled = true;
                        clearTimeout(timer);
                        clearModelIntervals();
                        resolve();
                    } catch (error) {
                        fail(error);
                    }
                },
            };

            // The upstream loader installs legacy Node exception handlers. Scope
            // those hooks to the model; it must not alter the host's error handling.
            const modelProcess = Object.create(process);
            modelProcess.on = (event, listener) => {
                if (event !== "uncaughtException" && event !== "unhandledRejection") {
                    process.on(event, listener);
                }
                return modelProcess;
            };
            const execute = vm.compileFunction(fs.readFileSync(MODEL_FILE, "utf8"),
                ["Module", "require", "module", "__filename", "__dirname", "process", "setInterval", "clearInterval"],
                { filename: MODEL_FILE });
            execute(options, createRequire(MODEL_FILE), { exports: {} }, MODEL_FILE,
                path.dirname(MODEL_FILE), modelProcess,
                (callback, delay) => {
                    const interval = setInterval(callback, delay);
                    modelIntervals.add(interval);
                    return interval;
                },
                (interval) => { clearInterval(interval); modelIntervals.delete(interval); });
        } catch (error) {
            fail(error);
        }
    });
}

class EdgeImpulseClassifier {
    init() {
        // All classifiers share one WASM instance and one startup promise.
        if (!initializationPromise) initializationPromise = initialize();
        return initializationPromise;
    }

    _requireRuntime() {
        if (!runtime) throw new Error("Module is not initialized");
        return runtime;
    }

    getProjectInfo() {
        const module = this._requireRuntime();
        return this._convertToOrdinaryJsObject(module.get_project(), module.emcc_classification_project_t.prototype);
    }

    getProperties() {
        const module = this._requireRuntime();
        return this._convertToOrdinaryJsObject(module.get_properties(), module.emcc_classification_properties_t.prototype);
    }

    classify(rawData, debug = false) {
        const module = this._requireRuntime();
        const properties = this.getProperties();
        if (!rawData || rawData.length !== properties.input_features_count) {
            throw new Error(`Expected ${properties.input_features_count} input features, received ${rawData?.length ?? 0}`);
        }
        return this._run(rawData, (ptr) => module.run_classifier(ptr, rawData.length, debug), properties);
    }

    classifyContinuous(rawData, enablePerfCal = true) {
        const module = this._requireRuntime();
        return this._run(rawData,
            (ptr) => module.run_classifier_continuous(ptr, rawData.length, false, enablePerfCal),
            this.getProperties());
    }

    setThreshold(value) {
        const result = this._requireRuntime().set_threshold(value);
        try {
            if (!result.success) throw new Error(result.error);
        } finally {
            result.delete?.();
        }
    }

    _run(rawData, classify, properties) {
        const module = this._requireRuntime();
        if ((!Array.isArray(rawData) && !ArrayBuffer.isView(rawData)) || !rawData.length) {
            throw new TypeError("Input must be a nonempty numeric array");
        }
        const values = Float32Array.from(rawData);
        if (!values.every(Number.isFinite)) throw new TypeError("Input features must be finite numbers");
        const ptr = module._malloc(values.byteLength);
        if (!ptr) throw new Error("Could not allocate model input buffer");
        let result;
        try {
            module.HEAPF32.set(values, ptr / Float32Array.BYTES_PER_ELEMENT);
            result = classify(ptr);
            if (result.result !== 0) throw new Error(`Classification failed (err code: ${result.result})`);
            return this._fillResultStruct(result, properties);
        } finally {
            try {
                result?.delete();
            } finally {
                module._free(ptr);
            }
        }
    }

    _convertToOrdinaryJsObject(bound, prototype) {
        try {
            const result = {};
            for (const key of Object.getOwnPropertyNames(prototype)) {
                if (typeof Object.getOwnPropertyDescriptor(prototype, key)?.get === "function") {
                    const value = bound[key];
                    result[key] = Array.isArray(value) ? value.slice() : value;
                }
            }
            return result;
        } finally {
            bound.delete();
        }
    }

    _readResults(size, get, keys) {
        const values = [];
        for (let index = 0; index < size; index++) {
            const bound = get(index);
            try {
                values.push(Object.fromEntries(keys.map((key) => [key, bound[key]])));
            } finally {
                bound.delete();
            }
        }
        return values;
    }

    _fillResultStruct(result, properties) {
        const boundingBoxKeys = ["label", "value", "x", "y", "width", "height"];
        const detection = ["object_detection", "constrained_object_detection"].includes(properties.model_type);
        const converted = {
            anomaly: result.anomaly,
            results: this._readResults(result.size(), (i) => result.get(i),
                detection ? boundingBoxKeys : ["label", "value"]),
        };
        if (properties.has_object_tracking) {
            converted.object_tracking_results = this._readResults(result.object_tracking_size(),
                (i) => result.object_tracking_get(i), ["object_id", ...boundingBoxKeys]);
        }
        if (properties.has_visual_anomaly_detection) {
            converted.visual_ad_max = result.visual_ad_max;
            converted.visual_ad_mean = result.visual_ad_mean;
            converted.visual_ad_grid_cells = this._readResults(result.visual_ad_grid_cells_size(),
                (i) => result.visual_ad_grid_cells_get(i), boundingBoxKeys);
        }
        const freeform = result.freeform;
        if (freeform) {
            try {
                converted.freeform = [];
                for (let index = 0; index < freeform.size(); index++) {
                    const tensor = freeform.get(index);
                    try {
                        converted.freeform.push(Array.from({ length: tensor.size() }, (_, i) => tensor.get(i)));
                    } finally {
                        tensor.delete?.();
                    }
                }
            } finally {
                freeform.delete?.();
            }
        }
        return converted;
    }
}

module.exports = EdgeImpulseClassifier;
