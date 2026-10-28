const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.CLAUDE_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-session-'));
const st = require('../plugin/scripts/jev-state');
const { handle, CARRY_MAX_AGE_MS } = require('../plugin/scripts/jev-session');

const fresh = () => {
  const s = { ...st.DEFAULT_STATE, sessions: {} };
  st.putSessionSetting(s, 'old', 'prefer', 'codex');
  st.putSessionSetting(s, 'old', 'review', false);
  st.markGuided(s, 'old', false);
  return s;
};
const now = Date.now();

test('/clear carries prefer and review to the new session, not guidance', () => {
  const s = fresh();
  assert.ok(handle('end', { session_id: 'old', reason: 'clear', cwd: '/p' }, s, now));
  assert.ok(handle('start', { session_id: 'new', source: 'clear', cwd: '/p' }, s, now + 1000));
  assert.strictEqual(st.preferFor(s, 'new', null), 'codex');
  assert.strictEqual(st.reviewFor(s, 'new'), false);
  assert.strictEqual(st.guidedFor(s, 'new', false), false, 'new context needs the full text');
  assert.deepStrictEqual(s.clearCarry, {});
});

test('no carry across directories, after the time limit, or for other end reasons', () => {
  let s = fresh();
  handle('end', { session_id: 'old', reason: 'clear', cwd: '/p' }, s, now);
  handle('start', { session_id: 'new', source: 'clear', cwd: '/q' }, s, now);
  assert.strictEqual(st.preferFor(s, 'new', null), 'claude');
  s = fresh();
  handle('end', { session_id: 'old', reason: 'clear', cwd: '/p' }, s, now);
  handle('start', { session_id: 'new', source: 'clear', cwd: '/p' }, s, now + CARRY_MAX_AGE_MS + 1);
  assert.strictEqual(st.preferFor(s, 'new', null), 'claude');
  s = fresh();
  assert.strictEqual(handle('end', { session_id: 'old', reason: 'logout' }, s, now), false);
  assert.deepStrictEqual(s.clearCarry, {});
});

test('compaction resets the guidance so the next Codex note is full', () => {
  const s = fresh();
  assert.ok(handle('start', { session_id: 'old', source: 'compact' }, s, now));
  assert.strictEqual(st.guidedFor(s, 'old', false), false);
  assert.strictEqual(st.preferFor(s, 'old', null), 'codex', 'settings stay');
  assert.strictEqual(handle('start', { session_id: 'old', source: 'compact' }, s, now), false, 'nothing to reset');
});

test('two /clears in one directory before either new session starts carry nothing', () => {
  const s = fresh();
  st.putSessionSetting(s, 'other', 'prefer', 'codex');
  handle('end', { session_id: 'old', reason: 'clear', cwd: '/p' }, s, now);
  handle('end', { session_id: 'other', reason: 'clear', cwd: '/p' }, s, now + 10);
  handle('start', { session_id: 'new1', source: 'clear', cwd: '/p' }, s, now + 20);
  handle('start', { session_id: 'new2', source: 'clear', cwd: '/p' }, s, now + 30);
  assert.strictEqual(st.preferFor(s, 'new1', null), 'claude');
  assert.strictEqual(st.reviewFor(s, 'new1'), true);
  assert.strictEqual(st.preferFor(s, 'new2', null), 'claude');
  assert.strictEqual(st.reviewFor(s, 'new2'), true);
});

test('a /clear in another directory does not block the carry', () => {
  const s = fresh();
  handle('end', { session_id: 'old', reason: 'clear', cwd: '/p' }, s, now);
  handle('end', { session_id: 'other', reason: 'clear', cwd: '/q' }, s, now + 10);
  handle('start', { session_id: 'new', source: 'clear', cwd: '/p' }, s, now + 20);
  assert.strictEqual(st.preferFor(s, 'new', null), 'codex');
});
