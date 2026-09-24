#!/usr/bin/env node
// jev-compact — keeps the working details a compaction summary tends to drop.
//
//   jev-compact.js save      PreCompact hook: reads the transcript since the
//                            last compaction and saves a short digest
//   jev-compact.js restore   SessionStart hook (source "compact"): hands the
//                            digest to Claude as context, then deletes it
//
// PreCompact hooks can block compaction but can't add to its instructions,
// so the digest reaches Claude right after it instead. It is built from the
// transcript, not by a model: the user's latest requests, the files edited
// or written, and how Claude's last reply ended. Nothing leaves the machine.

const fs = require('fs');
const path = require('path');
const st = require('./jev-state');

// Compaction only matters on long sessions; their newest part is enough.
const TRANSCRIPT_TAIL_BYTES = 8 * 1024 * 1024;
const REQUESTS = 3;
const REQUEST_CHARS = 400;
const FILES = 20;
const REPLY_CHARS = 600;
const EDIT_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'];

function digestPath(sessionId) {
  return st.dataFile(`compact-${String(sessionId).replace(/[^A-Za-z0-9_-]/g, '_')}.json`);
}

function readTail(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, TRANSCRIPT_TAIL_BYTES);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    return buf.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

const clip = (text, n) => (text.length > n ? `${text.slice(0, n)}...` : text);

// Text the user typed, or null for tool results, slash commands, the previous
// compaction's summary and other entries Claude Code adds.
function userText(entry) {
  if (entry.type !== 'user' || entry.isSidechain || entry.isMeta || entry.isCompactSummary) return null;
  const content = entry.message && entry.message.content;
  let text = null;
  if (typeof content === 'string') text = content;
  else if (Array.isArray(content) && !content.some((b) => b.type === 'tool_result')) {
    text = content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  }
  if (!text || !text.trim()) return null;
  // Harness messages (commands, task notifications, reminders) open with a tag.
  if (/^\s*<[a-z][a-z-]*[\s>]/.test(text)) return null;
  return text.trim();
}

// Digest of the transcript since the last compaction, or null when there is
// nothing worth keeping. Paths under cwd are shown relative to it.
function buildDigest(text, cwd) {
  const entries = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    try { entries.push(JSON.parse(line)); } catch (e) { /* first line may be cut */ }
  }
  let start = 0;
  entries.forEach((e, i) => { if (e.type === 'system' && e.subtype === 'compact_boundary') start = i + 1; });

  const requests = [];
  const files = [];
  let reply = null;
  for (const e of entries.slice(start)) {
    const typed = userText(e);
    if (typed) requests.push(typed);
    if (e.type !== 'assistant' || e.isSidechain || !e.message || !Array.isArray(e.message.content)) continue;
    for (const b of e.message.content) {
      if (b.type === 'tool_use' && EDIT_TOOLS.includes(b.name) && b.input) {
        const file = b.input.file_path || b.input.notebook_path;
        if (typeof file === 'string') {
          const at = files.indexOf(file);
          if (at >= 0) files.splice(at, 1);
          files.push(file);
        }
      }
      if (b.type === 'text' && b.text && b.text.trim()) reply = b.text.trim();
    }
  }
  if (requests.length === 0 && files.length === 0) return null;

  const lines = ['Jev kept these details from before the compaction, in case the summary left them out:'];
  if (requests.length > 0) {
    lines.push('Latest requests from the user (oldest first):');
    for (const r of requests.slice(-REQUESTS)) lines.push(`- ${clip(r.replace(/\s+/g, ' '), REQUEST_CHARS)}`);
  }
  const show = (f) => {
    const rel = cwd ? path.relative(cwd, f) : f;
    return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : f;
  };
  if (files.length > 0) lines.push(`Files edited or written (most recent last): ${files.slice(-FILES).map(show).join(', ')}`);
  if (reply) lines.push(`Your last reply ended with: ${clip(reply.slice(-REPLY_CHARS * 2).replace(/\s+/g, ' '), REPLY_CHARS)}`);
  return lines.join('\n');
}

function save(hookInput) {
  if (!st.readState().enabled || !hookInput.session_id || !hookInput.transcript_path) return;
  const digest = buildDigest(readTail(hookInput.transcript_path), hookInput.cwd);
  const file = digestPath(hookInput.session_id);
  if (digest) fs.writeFileSync(file, JSON.stringify({ at: Date.now(), digest }));
  else fs.rmSync(file, { force: true });
}

// Output for the SessionStart hook, or null.
function restore(hookInput) {
  if (hookInput.source !== 'compact' || !hookInput.session_id) return null;
  if (!st.readState().enabled) return null;
  const file = digestPath(hookInput.session_id);
  let saved;
  try {
    saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return null;
  }
  fs.rmSync(file, { force: true });
  // A digest from an earlier compaction whose restore never ran is stale.
  if (!saved.digest || Date.now() - saved.at > 60 * 60 * 1000) return null;
  return { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: saved.digest } };
}

module.exports = { buildDigest, save, restore, digestPath };

if (require.main === module) {
  const mode = process.argv[2];
  let input = '';
  process.stdin.on('data', (chunk) => { input += chunk; });
  process.stdin.on('end', () => {
    try {
      const hookInput = JSON.parse(input || '{}');
      if (mode === 'save') save(hookInput);
      else if (mode === 'restore') {
        const out = restore(hookInput);
        if (out) process.stdout.write(JSON.stringify(out));
      }
    } catch (e) {
      // Never block or disturb a compaction over the digest.
    }
  });
}
