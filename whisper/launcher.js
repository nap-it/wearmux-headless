#!/usr/bin/env node
// Loads config/whisper.ini into the environment, then spawns whisper/runner.py
// using the venv Python if available, falling back to system python3.

const { spawn } = require("child_process");
const path = require("path");
const fs   = require("fs");
const { loadConfigFile } = require("../utils/ini-config");

const ROOT       = path.resolve(__dirname, "..");
const CONFIG_INI = path.join(ROOT, "config", "whisper.ini");
const SCRIPT     = path.join(__dirname, "runner.py");

const VENV_PY_UNIX = path.join(ROOT, "venv", "bin", "python3");
const VENV_PY_WIN  = path.join(ROOT, "venv", "Scripts", "python.exe");

function resolvePython() {
    if (process.platform === "win32") {
        return fs.existsSync(VENV_PY_WIN) ? VENV_PY_WIN : "python";
    }
    return fs.existsSync(VENV_PY_UNIX) ? VENV_PY_UNIX : "python3";
}

function signalToExitCode(signal) {
    if (signal === "SIGINT")  return 130;
    if (signal === "SIGTERM") return 143;
    return 1;
}

const { loaded, configPath } = loadConfigFile(CONFIG_INI, { applyEnv: true });
if (loaded) {
    console.log(`[whisper-launcher] loaded config: ${configPath}`);
} else {
    console.warn(`[whisper-launcher] config not found at ${CONFIG_INI}, proceeding with current environment`);
}

const python = resolvePython();
console.log(`[whisper-launcher] starting: ${python} ${SCRIPT}`);

const child = spawn(python, [SCRIPT], { stdio: "inherit", env: process.env });

let childExited = false;

child.on("error", (err) => {
    console.error(`[whisper-launcher] failed to start Python: ${err.message}`);
    console.error("[whisper-launcher] run: npm run whisper:setup");
    process.exit(1);
});

child.on("exit", (code, signal) => {
    childExited = true;
    process.exit(signal ? signalToExitCode(signal) : (code || 0));
});

const forward = (sig) => {
    if (!childExited && !child.killed) child.kill(sig);
};

process.on("SIGINT",  () => forward("SIGINT"));
process.on("SIGTERM", () => forward("SIGTERM"));
