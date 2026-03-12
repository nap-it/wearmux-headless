#!/usr/bin/env node
const { spawn } = require("child_process");
const path = require("path");
const { loadConfigFile } = require("../utils/ini-config");

function findArg(flag) {
    const idx = process.argv.indexOf(flag);
    return idx > -1 ? process.argv[idx + 1] : undefined;
}

function removeArgPair(args, flag) {
    const idx = args.indexOf(flag);
    if (idx === -1) return args;
    return args.slice(0, idx).concat(args.slice(idx + 2));
}

async function main() {
    const explicitConfig = findArg("--config");
    const args = removeArgPair(process.argv.slice(2), "--config");

    if (args.length === 0) {
        console.error("[run-with-config] usage: node tools/run-with-config.js [--config path] path/to/script.js [args...]");
        process.exit(1);
    }

    const { loaded, configPath } = loadConfigFile(explicitConfig, { applyEnv: true });
    if (loaded) {
        console.log(`[run-with-config] loaded config: ${configPath}`);
    } else {
        console.warn(`[run-with-config] config not found at ${configPath}, proceeding with current environment`);
    }

    const scriptPath = path.resolve(args[0]);
    const scriptArgs = args.slice(1);

    const child = spawn(process.execPath, [scriptPath, ...scriptArgs], {
        stdio: "inherit",
        env: process.env,
    });

    child.on("exit", (code, signal) => {
        if (signal) {
            process.kill(process.pid, signal);
            return;
        }
        process.exit(code || 0);
    });
}

main().catch((error) => {
    console.error("[run-with-config] fatal:", error?.stack || error?.message || String(error));
    process.exit(1);
});
