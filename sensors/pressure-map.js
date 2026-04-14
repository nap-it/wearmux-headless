// ASCII pressure map — renders per-sensor pressure as a sole-shaped grid in the terminal
const { SensorManager } = require("./lib/sensor-manager");
const { DeviceManager } = require("../utils/device-manager");

// Block characters ordered by intensity (low → high)
const BLOCKS = [" ", "░", "▒", "▓", "█"];

// Render a list of {position: {x,y}, normalizedValue} sensors into a COLS×ROWS ASCII grid.
// position.x: 0 = left edge, 1 = right edge
// position.y: 0 = toe, 1 = heel
function renderGrid(sensors, cols, rows) {
    const grid = Array.from({ length: rows }, () => new Array(cols).fill(" "));

    for (const s of sensors) {
        const col = Math.min(cols - 1, Math.floor(s.position.x * cols));
        const row = Math.min(rows - 1, Math.floor(s.position.y * rows));
        // Keep highest value if multiple sensors map to the same cell
        const current = BLOCKS.indexOf(grid[row][col]);
        const next = Math.min(BLOCKS.length - 1, Math.floor(s.normalizedValue * BLOCKS.length));
        if (next > current) grid[row][col] = BLOCKS[next];
    }

    const border = "+" + "-".repeat(cols) + "+";
    const lines = [border];
    for (const row of grid) {
        lines.push("|" + row.join("") + "|");
    }
    lines.push(border);
    return lines;
}

function buildFrame(leftSensors, rightSensors, leftCoP, rightCoP) {
    const left = renderGrid(leftSensors, 4, 8);
    const right = renderGrid(rightSensors, 4, 8);

    const rows = Math.max(left.length, right.length);
    const lines = ["  LEFT SOLE          RIGHT SOLE", "  toe                toe"];

    for (let i = 0; i < rows; i++) {
        lines.push("  " + (left[i] || "      ") + "        " + (right[i] || "      "));
    }

    lines.push("  heel               heel");

    const lStr = leftCoP ? `L CoP: (${leftCoP.x.toFixed(2)}, ${leftCoP.y.toFixed(2)})` : "";
    const rStr = rightCoP ? `R CoP: (${rightCoP.x.toFixed(2)}, ${rightCoP.y.toFixed(2)})` : "";
    if (lStr || rStr) lines.push("  " + lStr + "    " + rStr);

    lines.push("", "  " + BLOCKS.map((b, i) => b + " " + (i / BLOCKS.length).toFixed(1)).join("  "));

    return lines;
}

async function main() {
    console.log("Connecting to device...");
    const device = await new DeviceManager().connectToDevice();

    const sensorManager = new SensorManager(device, { enabledSensors: ["pressure"], sampleRate: 20 });
    await sensorManager.startSensors();

    const state = {
        left: { sensors: [], cop: null },
        right: { sensors: [], cop: null },
    };

    let lastFrameLines = 0;

    sensorManager.on("pressure", (event) => {
        const p = event.message?.pressure;
        if (!p) return;
        const side = event.side || "left";
        state[side].sensors = p.sensors || [];
        state[side].cop = p.normalizedCenter || null;

        const frame = buildFrame(state.left.sensors, state.right.sensors, state.left.cop, state.right.cop);
        // Move cursor up by the number of lines in the previous frame, then clear to end of screen
        const moveUp = lastFrameLines > 0 ? `\x1b[${lastFrameLines}A` : "";
        process.stdout.write(moveUp + "\x1b[J" + frame.join("\n") + "\n");
        lastFrameLines = frame.length + 1;
    });

    process.on("SIGINT", async () => {
        await sensorManager.stop();
        try { await device.disconnect(); } catch (e) { console.warn("[pressure-map] disconnect failed:", e?.message || e); }
        process.exit(0);
    });
}

main().catch((err) => {
    console.error(err?.message || err);
    process.exit(1);
});
