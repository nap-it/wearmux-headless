#!/usr/bin/env node
const { spawn } = require('child_process');
const fs = require('fs');
const { loadConfigFile } = require('../utils/ini-config');
const LOCK_PATH = '/tmp/wearmux-launcher.lock';

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

function findArg(flag, def) {
  const i = process.argv.indexOf(flag);
  return i > -1 ? process.argv[i + 1] : def;
}

async function main() {
  if (!acquireLauncherLock()) {
    process.exit(1);
  }
  process.on('exit', releaseLauncherLock);

  const explicitConfig = findArg('--config');
  const loadedConfig = loadConfigFile(explicitConfig, { applyEnv: true });
  let parsed = loadedConfig.parsed;
  if (loadedConfig.loaded) {
    console.log(`[launcher] loaded config: ${loadedConfig.configPath}`);
  } else {
    console.warn(`[launcher] config not found at ${loadedConfig.configPath}, proceeding with defaults`);
  }

  // Determine scripts to run strictly from config.ini [scripts]
  let scripts = parsed._scripts.map(s => s.cmd);
  if (!scripts.length) {
    console.error('[launcher] no scripts defined in [scripts] section of config.ini');
    process.exit(1);
  }

  // Spawn scripts sequentially or in parallel based on RUN_MODE
  const mode = (parsed._env.RUN_MODE || 'sequential').toLowerCase();
  const children = [];

  function spawnScript(name) {
    const script = process.env[`NPM_SCRIPT_${name.toUpperCase()}`] || name;
    const parts = script.match(/(?:[^\s"]+|"[^"]*")+/g) || [];
    const cmd = 'npm';
    const args = ['run', ...parts.map(p => p.replace(/^"|"$/g, ''))];
    console.log(`[launcher] starting: ${cmd} ${args.map(a => a.includes(' ') ? `"${a}"` : a).join(' ')}`);
    const child = spawn(cmd, args, { stdio: 'inherit', env: process.env });
    children.push(child);
    child.on('exit', (code, signal) => {
      console.log(`[launcher] script '${script}' exited code=${code} signal=${signal}`);
      if (mode === 'parallel' && code !== 0) exitWithCode(code || 1);
    });
    return child;
  }

  function shutdown() {
    console.log('[launcher] shutting down...');
    for (const c of children) {
      try { c.kill('SIGTERM'); } catch {}
    }
    setTimeout(() => {
      releaseLauncherLock();
      process.exit(0);
    }, 200);
  }
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  try {
    if (mode === 'parallel') {
      scripts.forEach(spawnScript);
    } else {
      for (const s of scripts) {
        const child = spawnScript(s);
        const code = await new Promise(resolve => child.on('exit', resolve));
        if (code !== 0) exitWithCode(code || 1);
      }
    }
  } finally {
    releaseLauncherLock();
  }
}

main().catch(err => {
  console.error('[launcher] fatal:', err?.stack || err?.message || String(err));
  process.exit(1);
});
