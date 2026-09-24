const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-substop-'));
process.env.CLAUDE_CONFIG_DIR = path.join(tmp, 'claude');
const dataDir = path.join(tmp, 'claude', 'mynameisjev');
fs.mkdirSync(dataDir, { recursive: true });
const stop = require('../plugin/scripts/jev-subagent-stop');

const entry = (id, model, usage) => JSON.stringify({ type: 'assistant', message: { id, model, usage } });
const u = (input, write, read, output) => ({ input_tokens: input, cache_creation_input_tokens: write, cache_read_input_tokens: read, output_tokens: output });

test('adds up usage per model, once per reply', () => {
  const text = [
    JSON.stringify({ type: 'user', message: { content: 'x' } }),
    entry('m1', 'claude-sonnet-5', u(2, 100, 1000, 50)),
    entry('m1', 'claude-sonnet-5', u(2, 100, 1000, 50)),
    entry('m2', 'claude-sonnet-5', u(1, 0, 1100, 20)),
    entry('m3', '<synthetic>', u(9, 9, 9, 9)),
    '{"cut off',
  ].join('\n');
  assert.deepStrictEqual(stop.tokenUse(text), { sonnet: { input: 3, cacheWrite: 100, cacheRead: 2100, output: 70 } });
});

test('derives the subagent transcript path', () => {
  assert.strictEqual(
    stop.transcriptPath({ transcript_path: '/p/s1.jsonl', session_id: 's1', agent_id: 'a9' }),
    path.join('/p', 's1', 'subagents', 'agent-a9.jsonl'));
  assert.strictEqual(stop.transcriptPath({ agent_transcript_path: '/x.jsonl', transcript_path: '/p/s1.jsonl' }), '/x.jsonl');
});

test('records only mynameisjev helpers, and accumulates', () => {
  fs.writeFileSync(path.join(dataDir, 'state.json'), JSON.stringify({ enabled: true }));
  const file = path.join(tmp, 'agent.jsonl');
  fs.writeFileSync(file, entry('m1', 'claude-haiku-4-5-20251001', u(10, 20, 30, 40)));
  assert.strictEqual(stop.record({ agent_type: 'Explore', agent_transcript_path: file }), null);
  stop.record({ agent_type: 'mynameisjev:tiny', agent_transcript_path: file });
  stop.record({ agent_type: 'mynameisjev:tiny', agent_transcript_path: file });
  const state = JSON.parse(fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8'));
  assert.deepStrictEqual(state.helperTokens.haiku, { runs: 2, input: 20, cacheWrite: 40, cacheRead: 60, output: 80 });
});
