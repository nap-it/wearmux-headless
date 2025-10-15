#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

function parseIni(content) {
  const lines = content.split(/\r?\n/);
  const result = { _env: {}, _scripts: [] };
  let section = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith(';') || line.startsWith('#')) continue;
    const mSec = line.match(/^\[(.+)\]$/);
    if (mSec) { section = mSec[1].toLowerCase(); continue; }
    const idx = line.indexOf('=');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const val = line.slice(idx + 1).trim();
    if (!section || section === 'env') {
      result._env[key] = val;
    } else if (section === 'scripts') {
      // allow multiple entries; comma-separated or one per line
      const list = val.split(',').map(s => s.trim()).filter(Boolean);
      result._scripts.push(...list.map(s => ({ name: key, cmd: s })));
    } else {
      // arbitrary sections treated as env namespace
      result._env[`${section.toUpperCase()}_${key}`] = val;
    }
  }
  return result;
}

function findArg(flag, def) {
  const i = process.argv.indexOf(flag);
  return i > -1 ? process.argv[i + 1] : def;
}

async function main() {
  const iniPath = findArg('--config', '/config/config.ini');
  let parsed = { _env: {}, _scripts: [] };
  if (fs.existsSync(iniPath)) {
    parsed = parseIni(fs.readFileSync(iniPath, 'utf8'));
    console.log(`[launcher] loaded config: ${iniPath}`);
  } else {
    console.warn(`[launcher] config not found at ${iniPath}, proceeding with defaults`);
  }

  // Apply env vars from config
  for (const [k, v] of Object.entries(parsed._env)) {
    process.env[k] = v;
  }

  // Ensure zenoh peer config points at zenoh-router service when running in Docker (override file if present)
  try {
    const peerFile = path.resolve(__dirname, '../zenoh/peer.json5');
    if (fs.existsSync(peerFile)) {
      const text = fs.readFileSync(peerFile, 'utf8');
      // naive replace of 127.0.0.1 to zenoh-router hostname if requested
      if (process.env.ZENOH_DOCKER_ROUTER === '1') {
        const updated = text.replace(/tcp\/127\.0\.0\.1:7447/g, 'tcp/zenoh-router:7447');
        if (updated !== text) fs.writeFileSync(peerFile, updated);
      }
    }
  } catch (e) {
    console.warn('[launcher] zenoh peer config adjustment failed:', e.message || e);
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
    const cmd = 'npm';
    const args = ['run', script];
    console.log(`[launcher] starting: ${cmd} ${args.join(' ')}`);
    const child = spawn(cmd, args, { stdio: 'inherit', env: process.env });
    children.push(child);
    child.on('exit', (code, signal) => {
      console.log(`[launcher] script '${script}' exited code=${code} signal=${signal}`);
      if (mode === 'sequential' && code !== 0) process.exit(code || 1);
    });
    return child;
  }

  function shutdown() {
    console.log('[launcher] shutting down...');
    for (const c of children) {
      try { c.kill('SIGTERM'); } catch {}
    }
    setTimeout(() => process.exit(0), 200);
  }
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  if (mode === 'parallel') {
    scripts.forEach(spawnScript);
  } else {
    for (const s of scripts) {
      const child = spawnScript(s);
      const code = await new Promise(resolve => child.on('exit', resolve));
      if (code !== 0) process.exit(code || 1);
    }
  }
}

main().catch(err => {
  console.error('[launcher] fatal:', err?.stack || err?.message || String(err));
  process.exit(1);
});
