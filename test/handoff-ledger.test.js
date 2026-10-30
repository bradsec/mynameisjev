const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-ledger-'));
process.env.CLAUDE_CONFIG_DIR = path.join(home, '.claude');
process.env.CODEX_HOME = path.join(home, '.codex');
const ledger = require('../plugin/scripts/jev-handoff-ledger');

test('reads last cumulative Codex token event and model from a fixture rollout', () => {
  const id = '12345678-1234-1234-1234-123456789abc';
  const dir = path.join(process.env.CODEX_HOME, 'sessions', '2026', '10', '30');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `rollout-fixture-${id}.jsonl`);
  fs.writeFileSync(file, [
    { type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 1 } } } },
    { type: 'turn_context', payload: { model: 'gpt-6-sol' } },
    { type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 10, cached_input_tokens: 2, output_tokens: 3, reasoning_output_tokens: 1 } } } },
  ].map(JSON.stringify).join('\n') + '\n');
  assert.deepEqual(ledger.codexUsage(id), { model: 'gpt-6-sol', input: 10, cacheRead: 2, output: 3, reasoningOutput: 1 });
  assert.equal(ledger.codexUsage('bad-id'), null);
  fs.appendFileSync(file, JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: null } }) + '\n');
  assert.equal(ledger.codexUsage(id), null, 'invalid last event stays unknown');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').split('\n').slice(0, -2).join('\n') + '\n');
});

test('counts Claude assistant replies once from the hand-off boundary', () => {
  const transcript = [
    { type: 'user', message: { content: 'task' } },
    { type: 'assistant', message: { id: 'a', model: 'claude-sonnet-4-5', usage: { input_tokens: 4, output_tokens: 2 } } },
    { type: 'assistant', message: { id: 'a', model: 'claude-sonnet-4-5', usage: { input_tokens: 5, output_tokens: 3 } } },
    { type: 'assistant', message: { id: 'b', model: 'claude-opus-4-5', usage: { input_tokens: 7, output_tokens: 1 } } },
  ].map(JSON.stringify).join('\n');
  assert.deepEqual(ledger.claudeUsage(transcript), { input: 12, cacheWrite: 0, cacheRead: 0, output: 4 });
});

test('records a background job across task and result, then finishes at Stop', () => {
  const id = '12345678-1234-1234-1234-123456789abc';
  const jobsDir = path.join(process.env.CLAUDE_CONFIG_DIR, 'plugins', 'data', 'codex-openai-codex', 'state', 'workspace');
  fs.mkdirSync(jobsDir, { recursive: true });
  fs.writeFileSync(path.join(jobsDir, 'state.json'), JSON.stringify({ jobs: [{ id: 'job-1', sessionId: 's', threadId: id, status: 'completed', updatedAt: '2026-10-30T00:00:00Z' }] }));
  const transcript = path.join(home, 'transcript.jsonl');
  fs.writeFileSync(transcript, [
    { type: 'user', message: { content: [{ type: 'text', text: 'task' }] } },
    { type: 'assistant', message: { id: 'brief', model: 'claude-sonnet-4-5', usage: { input_tokens: 5, output_tokens: 2 } } },
  ].map(JSON.stringify).join('\n') + '\n');
  const state = {};
  const hook = { session_id: 's', transcript_path: transcript };
  ledger.register(state, hook, 'job-1', false);
  assert.equal(state.handoffLedger.s.tasks[0].returned, false);
  fs.appendFileSync(transcript, JSON.stringify({ type: 'assistant', message: { id: 'review', model: 'claude-sonnet-4-5', usage: { input_tokens: 7, output_tokens: 3 } } }) + '\n');
  ledger.register(state, hook, 'job-1', true);
  ledger.finish(state, hook);
  assert.deepEqual(state.handoffLedger.s.tasks[0].claude, { input: 12, cacheWrite: 0, cacheRead: 0, output: 5 });
  assert.equal(state.handoffLedger.s.tasks[0].codex.input, 10);
  assert.deepEqual(state.handoffLedger.s.totals, { models: { 'gpt-6-sol': { runs: 1, input: 10, cacheRead: 2, output: 3, reasoningOutput: 1 } }, claude: 17, measured: 1, unknown: 0 });
  ledger.register(state, hook, 'job-1', true);
  assert.equal(state.handoffLedger.s.tasks.length, 1);
  const dataDir = path.join(process.env.CLAUDE_CONFIG_DIR, 'mynameisjev');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'state.json'), JSON.stringify({ enabled: true, handoffLedger: state.handoffLedger }));
  const output = execFileSync(process.execPath, [path.join(__dirname, '../plugin/scripts/jev-cli.js'), 'report', '--session'],
    { encoding: 'utf8', env: { ...process.env, CLAUDE_CODE_SESSION_ID: 's' } });
  assert.match(output, /Codex tokens \(this session\):/);
  assert.match(output, /gpt-6-sol: 1 tasks, input 10, cached input 2, output 3, reasoning output 1/);
  assert.match(output, /Claude hand-off overhead: 17 total, 17 mean per hand-off/);
});
