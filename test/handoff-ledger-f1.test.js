const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-ledger-f1-'));
process.env.HOME = home;
process.env.CLAUDE_CONFIG_DIR = path.join(home, '.claude');
process.env.CODEX_HOME = path.join(home, '.codex');
const ledger = require('../plugin/scripts/jev-handoff-ledger');
const { taskCommand } = require('../plugin/scripts/jev-codex');

test('matches foreground job before tool_result reaches transcript', () => {
  const sessionId = '11111111-2222-3333-4444-555555555555';
  const threadId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const dir = path.join(process.env.CLAUDE_CONFIG_DIR, 'plugins', 'data', 'codex-openai-codex', 'state', 'workspace');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ jobs: [
    { id: 'task-x1', sessionId, createdAt: '2026-11-06T05:20:53.660Z', threadId },
  ] }));
  const rolloutDir = path.join(process.env.CODEX_HOME, 'sessions', '2026', '11', '06');
  fs.mkdirSync(rolloutDir, { recursive: true });
  fs.writeFileSync(path.join(rolloutDir, `rollout-${threadId}.jsonl`), [
    { type: 'turn_context', payload: { model: 'gpt-6-sol' } },
    { type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: {
      input_tokens: 10, cached_input_tokens: 2, output_tokens: 3, reasoning_output_tokens: 1,
    } } } },
  ].map(JSON.stringify).join('\n') + '\n');
  const transcript = path.join(home, 'transcript.jsonl');
  const toolUse = { type: 'assistant', timestamp: '2026-11-06T05:20:53.581Z', message: { content: [
    { type: 'tool_use', id: 'tu1', name: 'Bash' },
  ] } };
  fs.writeFileSync(transcript, JSON.stringify(toolUse) + '\n');
  const fakeCompanion = path.join(home, 'codex-companion.mjs');
  fs.writeFileSync(fakeCompanion, `process.stdout.write('Task finished.\\n');\nprocess.stderr.write('[codex] Thread ready (${threadId}).\\n[codex] Thread ready (${threadId}).\\n');\n`);
  const output = execFileSync('sh', ['-c', taskCommand(fakeCompanion, '', 'brief')],
    { encoding: 'utf8', env: process.env });
  assert.equal(output, `Task finished.\n[codex] Thread ready (${threadId}).\n`);
  const state = {};
  const hook = { session_id: sessionId, transcript_path: transcript, tool_use_id: 'tu1',
    tool_response: { stdout: output } };
  ledger.register(state, hook);
  assert.equal(state.handoffLedger[sessionId].tasks[0].jobId, 'task-x1');
  assert.equal(state.handoffLedger[sessionId].tasks[0].threadId, threadId);
  assert.deepEqual(state.handoffLedger[sessionId].tasks[0].codex,
    { model: 'gpt-6-sol', input: 10, cacheRead: 2, output: 3, reasoningOutput: 1 });
});

test('resumed thread selects new job after older job was claimed', () => {
  const sessionId = '11111111-2222-3333-4444-555555555557';
  const threadId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const dir = path.join(process.env.CLAUDE_CONFIG_DIR, 'plugins', 'data', 'codex-openai-codex', 'state', 'workspace');
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ jobs: [
    { id: 'task-old', sessionId, threadId, createdAt: '2026-11-06T05:20:00Z' },
    { id: 'task-new', sessionId, threadId, createdAt: '2026-11-06T05:21:00Z' },
  ] }));
  const state = { handoffLedger: { [sessionId]: { at: Date.now(), tasks: [{ jobId: 'task-old' }] } } };
  ledger.register(state, { session_id: sessionId, tool_response: { stdout: `[codex] Thread ready (${threadId}).\n` } });
  assert.equal(state.handoffLedger[sessionId].tasks[1].jobId, 'task-new');
});

test('resumed thread selects newest of two unclaimed jobs', () => {
  const sessionId = '11111111-2222-3333-4444-555555555558';
  const threadId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const dir = path.join(process.env.CLAUDE_CONFIG_DIR, 'plugins', 'data', 'codex-openai-codex', 'state', 'workspace');
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ jobs: [
    { id: 'task-new', sessionId, threadId, createdAt: '2026-11-06T05:21:00Z' },
    { id: 'task-old', sessionId, threadId, createdAt: '2026-11-06T05:20:00Z' },
  ] }));
  const state = {};
  ledger.register(state, { session_id: sessionId, tool_response: { stdout: `[codex] Thread ready (${threadId}).\n` } });
  assert.equal(state.handoffLedger[sessionId].tasks[0].jobId, 'task-new');
  const missingSession = '11111111-2222-3333-4444-555555555559';
  ledger.register(state, { session_id: missingSession, tool_response: { stdout: `[codex] Thread ready (${threadId}).\n` } });
  assert.equal(state.handoffLedger[missingSession].tasks[0].jobId, null);
});

test('uses assistant tool_use offset when an api-request-blob repeats it', () => {
  const sessionId = '11111111-2222-3333-4444-555555555556';
  const transcript = path.join(home, 'blob.jsonl');
  const use = { type: 'tool_use', id: 'tu2', name: 'Bash' };
  fs.writeFileSync(transcript, [
    { type: 'assistant', timestamp: '2026-11-06T05:20:53.581Z', message: { content: [use] } },
    { type: 'api-request-blob', message: { content: [use] } },
  ].map(JSON.stringify).join('\n') + '\n');
  const state = {};
  ledger.register(state, { session_id: sessionId, transcript_path: transcript, tool_use_id: 'tu2' });
  assert.equal(state.handoffLedger[sessionId].tasks[0].start, 0);
});
