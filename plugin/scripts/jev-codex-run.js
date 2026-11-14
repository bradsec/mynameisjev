#!/usr/bin/env node
const { spawn, execFileSync } = require('child_process');
const { companionPath } = require('./jev-codex');

// After a foreground --write task the wrapper prints what the task changed,
// so Claude's review needs no separate calls for the stat and the diff.
const DIFF_MAX_CHARS = 12000;

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024, windowsHide: true });
}

// The worktree's diff split per file, plus untracked files, or null outside a
// git repository. Compared before and after the task, so changes already in
// the worktree are left out.
function snapshot() {
  try {
    const diff = git(['diff', '--no-color', '--no-ext-diff', 'HEAD']);
    const files = {};
    for (const chunk of diff.split(/^(?=diff --git )/m)) {
      const name = chunk.match(/^diff --git a\/(.*?) b\//)?.[1];
      if (name) files[name] = chunk;
    }
    const untracked = git(['ls-files', '--others', '--exclude-standard']).split('\n').filter(Boolean);
    return { files, untracked };
  } catch (_) {
    return null;
  }
}

function changeReport(before, after) {
  const changed = Object.keys(after.files).filter((name) => after.files[name] !== before.files[name]);
  const reverted = Object.keys(before.files).filter((name) => !(name in after.files));
  const added = after.untracked.filter((name) => !before.untracked.includes(name));
  if (!changed.length && !reverted.length && !added.length) return 'Jev: the task changed no files.\n';
  let text = `Jev: files the task changed (diff against HEAD${Object.keys(before.files).length ? '; files already dirty before the task show their whole diff' : ''}):\n`;
  for (const name of changed) text += `M ${name}\n`;
  for (const name of reverted) text += `R ${name} (back to HEAD)\n`;
  for (const name of added) text += `? ${name} (new, untracked)\n`;
  let diff = changed.map((name) => after.files[name]).join('');
  if (diff.length > DIFF_MAX_CHARS) diff = `${diff.slice(0, DIFF_MAX_CHARS)}\n[diff cut at ${DIFF_MAX_CHARS} characters; read the rest with git diff]\n`;
  return `${text}${diff}`;
}

const companion = companionPath();
if (!companion) {
  process.stderr.write('Codex companion not found.\n');
  process.exitCode = 1;
} else if (['status', 'result'].includes(process.argv[2])) {
  const child = spawn(process.execPath, [companion, ...process.argv.slice(2)], {
    stdio: 'inherit', windowsHide: true,
  });
  child.on('error', (error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
  child.on('close', (code) => { process.exitCode = code ?? 1; });
} else {
  const args = process.argv.slice(2);
  const before = args.includes('--write') && !args.includes('--background') ? snapshot() : null;
  const child = spawn(process.execPath, [companion, 'task', ...args], {
    stdio: ['pipe', 'inherit', 'pipe'], windowsHide: true,
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.on('error', (error) => { stderr += `${error.message}\n`; });
  child.stdin.on('error', (error) => {
    // A task can exit before consuming the whole brief.
    if (error.code !== 'EPIPE') {
      stderr += `${error.message}\n`;
      child.kill();
    }
  });
  process.stdin.pipe(child.stdin);
  child.on('close', (code) => {
    process.stdin.unpipe(child.stdin);
    process.stdin.pause();
    if (code === 0) {
      const thread = stderr.split(/\r?\n/).find((line) => line.includes('[codex] Thread ready ('));
      if (thread) process.stdout.write(`${thread}\n`);
      const after = before && snapshot();
      if (after) process.stdout.write(changeReport(before, after));
    } else {
      const lines = stderr.match(/[^\n]*\n|[^\n]+$/g) || [];
      process.stderr.write(lines.slice(-20).join(''));
    }
    process.exitCode = code ?? 1;
  });
}
