const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('refresh records an app-server early exit and removes its lock', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-codex-f3-'));
  try {
    const claude = path.join(home, '.claude');
    const dataDir = path.join(claude, 'mynameisjev');
    const binDir = path.join(home, 'bin');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.mkdirSync(binDir);
    fs.writeFileSync(path.join(binDir, 'codex'), '#!/bin/sh\nexit 3\n', { mode: 0o755 });
    fs.writeFileSync(path.join(dataDir, 'codex-refresh.lock'), 'lock');

    const result = spawnSync(process.execPath, [path.join(__dirname, '../plugin/scripts/jev-codex.js'), 'refresh'], {
      encoding: 'utf8',
      timeout: 15000,
      env: {
        ...process.env,
        HOME: home,
        CLAUDE_CONFIG_DIR: claude,
        CODEX_HOME: path.join(home, '.codex'),
        PATH: `${binDir}${path.delimiter}${process.env.PATH || ''}`,
      },
    });
    const cachePath = path.join(dataDir, 'codex-cache.json');
    const lockPath = path.join(dataDir, 'codex-refresh.lock');
    assert.deepEqual({ exit: result.status, cache: fs.existsSync(cachePath), lock: fs.existsSync(lockPath) },
      { exit: 0, cache: true, lock: false }, result.stderr);
    const cache = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    assert.match(cache.error, /codex app-server/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
