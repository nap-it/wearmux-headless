const fs = require("node:fs");
const os = require("node:os");
const { randomUUID } = require("node:crypto");

const LATENCY_TOPIC = "latency/events/v1";
const processInstance = randomUUID();
let bootId = "unavailable";
try { bootId = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(); } catch {}
const hostId = process.env.HITL_HOST_ID || os.hostname();
let clockDomain = bootId === "unavailable"
    ? `headless:${hostId}:${processInstance}:monotonic`
    : `linux:${bootId}:monotonic`;
let clockNamespace;
try { clockNamespace = fs.readlinkSync("/proc/self/ns/time"); } catch {}
try {
    const shifted = fs.readFileSync("/proc/self/timens_offsets", "utf8").trim().split(/\n/)
        .some((line) => line.trim().split(/\s+/).slice(1).some((value) => BigInt(value) !== 0n));
    if (shifted && clockNamespace && bootId !== "unavailable") clockDomain += `:timens:${clockNamespace}`;
} catch {}
let sequence = 0;

// Sample clocks at the event boundary, never when deferred telemetry is sent.
// Wall time has millisecond resolution despite its decimal nanosecond encoding.
function captureTime() {
    return {
        wall_time_ns: `${Date.now()}000000`,
        mono_time_ns: process.hrtime.bigint().toString(),
    };
}

function latencyEvent(stage, fields = {}, captured = captureTime()) {
    const seq = ++sequence;
    return {
        ...fields,
        schema: 1, source: "wearmux", stage,
        trace_event_id: `${processInstance}:${seq}`, sequence: seq,
        host_id: hostId, boot_id: bootId, process_instance: processInstance,
        clock_domain: clockDomain, clock_namespace: clockNamespace, mono_clock: "process.hrtime.bigint",
        wall_clock_resolution_ns: "1000000",
        ...captured,
    };
}

// The bounded queue is independent of the interaction and BLE write paths.
// A stuck/rejecting/offline publisher cannot block a response or grow this queue.
function createLatencyEmitter(publisher, { maxPending = 128 } = {}) {
    let pending = 0;
    let dropped = 0;
    let failures = 0;
    const emit = (stage, fields = {}, captured) => {
        if (!publisher || pending >= maxPending) { dropped++; return; }
        let event;
        try {
            // Snapshot nested inference/clock data before another callback mutates it.
            event = JSON.parse(JSON.stringify(latencyEvent(stage, {
                ...fields, telemetry_dropped: dropped, telemetry_failures: failures,
            }, captured)));
        } catch { failures++; return; }
        pending++;
        setImmediate(() => {
            try {
                Promise.resolve(publisher.publish(LATENCY_TOPIC, event))
                    .catch(() => { failures++; })
                    .finally(() => { pending--; });
            } catch { failures++; pending--; }
        });
    };
    emit.stats = () => ({ pending, dropped, failures });
    return emit;
}

module.exports = { LATENCY_TOPIC, captureTime, latencyEvent, createLatencyEmitter };
