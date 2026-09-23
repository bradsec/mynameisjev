// jev-exec — start external CLIs (claude, codex, rtk, git) the same way on
// Linux, macOS and Windows.
//
// On Windows, npm-installed CLIs are .cmd shims, which Node can only start
// through a shell (the codex plugin's own runtime does the same). Arguments
// passed here are fixed words, ids and file paths, never user text, so the
// only quoting needed is for paths with spaces.

const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');

const isWindows = process.platform === 'win32';

// Full path of an executable on PATH, or null. File lookups only, so it is
// cheap enough for hooks that run on every prompt.
function findOnPath(name) {
  const exts = isWindows ? (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean) : [''];
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext);
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch (e) {
        // Not in this directory.
      }
    }
  }
  return null;
}

function platformArgs(args) {
  return isWindows ? args.map((a) => (/[\s&|<>^()]/.test(a) ? `"${a}"` : a)) : args;
}

function platformOpts(opts) {
  return isWindows ? { ...opts, shell: true, windowsHide: true } : opts;
}

// execFile as a promise: resolves stdout, rejects with the last stderr line.
function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, platformArgs(args), platformOpts({ timeout: 120000, maxBuffer: 4 * 1024 * 1024, ...opts }), (err, stdout, stderr) => {
      if (err) reject(new Error(`${cmd} ${args.join(' ')} failed: ${(stderr || err.message).trim().split('\n').pop()}`));
      else resolve(stdout);
    });
  });
}

function spawnCli(cmd, args, opts = {}) {
  return spawn(cmd, platformArgs(args), platformOpts(opts));
}

module.exports = { isWindows, findOnPath, run, spawnCli };
