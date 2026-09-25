#!/usr/bin/env node
const { spawn } = require('child_process');
const fs = require('fs');
const { loadConfigFile } = require('../utils/ini-config');
const LOCK_PATH = '/tmp/wearmux-headless-launcher.lock';

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function acquireLauncherLock() {
  try {
    const fd = fs.openSync(LOCK_PATH, 'wx');
    fs.writeFileSync(fd, `${process.pid}\n`);
    fs.closeSync(fd);
    return true;
  } catch (error) {
    if (error.code !== 'EEXIST') {
      throw error;
    }

    let existingPid = NaN;
    try {
      existingPid = Number.parseInt(fs.readFileSync(LOCK_PATH, 'utf8').trim(), 10);
    } catch {}

    if (isProcessAlive(existingPid)) {
      console.error(`[launcher] another launcher is already running (pid=${existingPid})`);
      return false;
    }

    try {
      fs.unlinkSync(LOCK_PATH);
    } catch (unlinkErr) {
      console.error(`[launcher] failed to remove stale lock ${LOCK_PATH}: ${unlinkErr?.message || unlinkErr}`);
      return false;
    }

    return acquireLauncherLock();
  }
}

function releaseLauncherLock() {
  try {
    const existingPid = Number.parseInt(fs.readFileSync(LOCK_PATH, 'utf8').trim(), 10);
    if (existingPid === process.pid) {
      fs.unlinkSync(LOCK_PATH);
    }
  } catch {}
}

function exitWithCode(code) {
  releaseLauncherLock();
  process.exit(code);
}

function findArg(flag) {
  const i = process.argv.indexOf(flag);
  return i > -1 ? process.argv[i + 1] : undefined;
}

async function main() {
  if (!acquireLauncherLock()) {
    process.exit(1);
  }
  process.on('exit', releaseLauncherLock);

  const explicitConfig = findArg('--config');
  const loadedConfig = loadConfigFile(explicitConfig, { applyEnv: true });
  const parsed = loadedConfig.parsed;
  if (loadedConfig.loaded) {
    console.log(`[launcher] loaded config: ${loadedConfig.configPath}`);
  } else {
    console.warn(`[launcher] config not found at ${loadedConfig.configPath}, proceeding with defaults`);
  }

  const scripts = parsed._scripts.map(s => s.cmd);
  if (!scripts.length) {
    console.error('[launcher] no scripts defined in [scripts] section of config.ini');
    process.exit(1);
  }

  // Every configured script is a service; run them together and keep the lock
  // until the launcher and its children have stopped.
  const children = new Set();
  let stopping = false;
  let exitCode = 0;

  function shutdown(code = 0) {
    if (stopping) return;
    stopping = true;
    exitCode = code;
    for (const child of children) {
      try { child.kill('SIGTERM'); } catch {}
    }
    if (children.size === 0) exitWithCode(exitCode);
    setTimeout(() => exitWithCode(exitCode), 5000).unref();
  }

  function spawnScript(name) {
    const script = name;
    const parts = script.match(/(?:[^\s"]+|"[^"]*")+/g) || [];
    const cmd = 'npm';
    const args = ['run', ...parts.map(p => p.replace(/^"|"$/g, ''))];
    console.log(`[launcher] starting: ${cmd} ${args.map(a => a.includes(' ') ? `"${a}"` : a).join(' ')}`);
    const child = spawn(cmd, args, { stdio: 'inherit', env: process.env });
    children.add(child);
    child.on('error', (error) => {
      console.error(`[launcher] failed to start '${script}': ${error.message}`);
      shutdown(1);
    });
    child.on('close', (code, signal) => {
      children.delete(child);
      console.log(`[launcher] script '${script}' exited code=${code} signal=${signal}`);
      if (!stopping && children.size === 0) exitWithCode(code || 0);
      if (!stopping) shutdown(code || 1);
      else if (children.size === 0) exitWithCode(exitCode);
    });
    return child;
  }

  process.on('SIGINT', () => shutdown(130));
  process.on('SIGTERM', () => shutdown(143));
  scripts.forEach(spawnScript);
}

main().catch(err => {
  console.error('[launcher] fatal:', err?.stack || err?.message || String(err));
  process.exit(1);
});
