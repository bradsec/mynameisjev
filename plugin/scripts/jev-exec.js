// jev-exec — start external CLIs (claude, codex, rtk, git) the same way on
// Linux, macOS and Windows.
//
// On Windows, npm-installed CLIs are .cmd shims, which Node can only start
// through a shell (the codex plugin's own runtime does the same). Only those
// shims go through the shell, and only with arguments free of shell
// metacharacters (see shellSafe): some arguments come from third-party
// marketplace files, and cmd.exe quoting cannot contain them safely. Real
// executables, and everything on Linux and macOS, run without a shell.

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

// Arguments allowed through cmd.exe: letters, digits and path/id punctuation.
// Spaces are allowed and get quoted; quotes and every cmd.exe metacharacter
// (& | < > ^ % ! ( ) and the like) are refused.
function shellSafe(arg) {
  return /^[A-Za-z0-9_@.:\/\\=+,~ -]*$/.test(arg);
}

// How to start `cmd`: { file, args, opts }. Throws when a Windows shim would
// need an argument the shell can't take safely.
function invocation(cmd, args, opts) {
  if (!isWindows) return { file: cmd, args, opts };
  const resolved = findOnPath(cmd) || cmd;
  if (!/\.(cmd|bat)$/i.test(resolved)) return { file: resolved, args, opts: { ...opts, windowsHide: true } };
  const bad = args.find((a) => !shellSafe(a));
  if (bad !== undefined) throw new Error(`refusing to pass ${JSON.stringify(bad)} to ${cmd} through the Windows shell`);
  return {
    file: `"${resolved}"`,
    args: args.map((a) => (/\s/.test(a) ? `"${a}"` : a)),
    opts: { ...opts, shell: true, windowsHide: true },
  };
}

// execFile as a promise: resolves stdout, rejects with the last stderr line.
function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    let inv;
    try {
      inv = invocation(cmd, args, { timeout: 120000, maxBuffer: 4 * 1024 * 1024, ...opts });
    } catch (e) {
      reject(e);
      return;
    }
    execFile(inv.file, inv.args, inv.opts, (err, stdout, stderr) => {
      if (err) reject(new Error(`${cmd} ${args.join(' ')} failed: ${(stderr || err.message).trim().split('\n').pop()}`));
      else resolve(stdout);
    });
  });
}

function spawnCli(cmd, args, opts = {}) {
  const inv = invocation(cmd, args, opts);
  return spawn(inv.file, inv.args, inv.opts);
}

module.exports = { isWindows, findOnPath, shellSafe, run, spawnCli };
