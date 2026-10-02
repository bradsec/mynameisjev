const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-check-'));
const claudeDir = path.join(tmp, 'claude');
const dataDir = path.join(claudeDir, 'mynameisjev');
fs.mkdirSync(dataDir, { recursive: true });
process.env.CLAUDE_CONFIG_DIR = claudeDir;
const check = require('../plugin/scripts/jev-check');

const statePath = path.join(dataDir, 'state.json');
const setState = (over = {}) => fs.writeFileSync(statePath, JSON.stringify({ enabled: true, completeCheck: true, ...over }));
const readState = () => JSON.parse(fs.readFileSync(statePath, 'utf8'));

function transcript(prompt) {
  const file = path.join(tmp, `t-${Math.random().toString(36).slice(2)}.jsonl`);
  const lines = [
    { type: 'user', message: { role: 'user', content: 'an older request that was already done' } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'done' }] } },
    { type: 'user', message: { role: 'user', content: prompt } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/p/a.js' } }] } },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] } },
  ];
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return file;
}

const REQUEST = 'Add a retry to the fetch helper.\n- cover it with a test\n- update the README';
const input = (over = {}) => ({
  session_id: 's1', cwd: tmp, hook_event_name: 'Stop', stop_hook_active: false,
  transcript_path: transcript(REQUEST), last_assistant_message: 'Added the retry and a test.', ...over,
});
// Jev stub: covered probability per part key, asks_user probability.
const jev = (covered, asksUser = 0.05) => {
  const calls = [];
  const ask = async (state, questions, opts) => {
    calls.push({ state, questions, opts });
    const answers = { asks_user: { noul: asksUser } };
    Object.keys(questions).filter((k) => k.startsWith('p')).forEach((k, i) => { answers[k] = { noul: covered[i] ?? 0.9 }; });
    return { answers, usage: { cost: 0.00003 } };
  };
  return { ask, calls };
};
const env = { OPENROUTER_API_KEY: 'sk-test' };

test('splitParts uses list lines, plus any lead sentence', () => {
  assert.deepStrictEqual(check.splitParts(REQUEST), ['Add a retry to the fetch helper.', 'cover it with a test', 'update the README']);
  assert.deepStrictEqual(check.splitParts('1. first thing to do\n2) second thing to do\n* third thing to do'), ['first thing to do', 'second thing to do', 'third thing to do']);
});

test('splitParts falls back to sentences, drops short fragments, caps count and length', () => {
  assert.deepStrictEqual(check.splitParts('Fix the login bug. Ok. Then deploy it to staging! Why does CI fail?'),
    ['Fix the login bug.', 'Then deploy it to staging!', 'Why does CI fail?']);
  const many = Array.from({ length: 12 }, (_, i) => `- task number ${i} here`).join('\n');
  assert.strictEqual(check.splitParts(many).length, check.MAX_PARTS);
  assert.ok(check.splitParts(`${'x'.repeat(500)} done.`)[0].length <= check.PART_CHARS);
});

test('buildRequest asks one noul per part plus asks_user, redacted and clipped', () => {
  const key = 'sk-or-v1-' + 'a'.repeat(40);
  const { state, questions, parts } = check.buildRequest(`Use ${key} to fix the upload bug.`, 'r'.repeat(30000));
  assert.deepStrictEqual(Object.keys(questions), ['p1', 'asks_user']);
  assert.strictEqual(questions.p1.type, 'noul');
  assert.strictEqual(parts.length, 1);
  assert.ok(state.reply.length <= check.REPLY_CHARS + 3);
  assert.doesNotMatch(JSON.stringify({ state, questions }), /aaaaaaaaaa/);
});

test('missedParts: below threshold is missed; asks_user clears it', () => {
  const parts = ['a part', 'b part'];
  assert.deepStrictEqual(check.missedParts({ p1: { noul: 0.9 }, p2: { noul: 0.1 }, asks_user: { noul: 0.1 } }, parts), ['b part']);
  assert.deepStrictEqual(check.missedParts({ p1: { noul: 0.9 }, p2: { noul: 0.1 }, asks_user: { noul: 0.8 } }, parts), []);
  assert.deepStrictEqual(check.missedParts({ p1: { noul: 0.35 }, p2: {}, asks_user: { noul: 0.1 } }, parts), []);
});

test('handle blocks once with the missed parts quoted', async () => {
  setState();
  const { ask, calls } = jev([0.95, 0.9, 0.1]);
  const out = await check.handle(input(), { ask, env });
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].state.request, REQUEST);
  assert.strictEqual(out.decision, 'block');
  assert.match(out.reason, /- "update the README"/);
  assert.doesNotMatch(out.reason, /cover it with a test/);
  assert.match(out.reason, /once per turn/);
  assert.match(out.systemMessage, /Jev/);
  const s = readState();
  assert.strictEqual(s.stats.checks, 1);
  assert.strictEqual(s.stats.checkBlocks, 1);
  assert.strictEqual(s.lastCall.ok, true);
  assert.deepStrictEqual(s.costs.check, { calls: 1, cost: 0.00003 });
});

test('handle lets the turn stop when every part is covered', async () => {
  setState();
  const { ask } = jev([0.9, 0.9, 0.9]);
  assert.strictEqual(await check.handle(input(), { ask, env }), null);
  assert.strictEqual(readState().stats.checkBlocks, 0);
});

test('handle skips without calling Jev', async (t) => {
  const cases = [
    ['feature off', () => setState({ completeCheck: false }), input(), env],
    ['router off', () => setState({ enabled: false }), input(), env],
    ['already continued once', () => setState(), input({ stop_hook_active: true }), env],
    ['no API key', () => setState(), input(), {}],
    ['trivial request', () => setState(), input({ transcript_path: transcript('ok thanks') }), env],
    ['no transcript', () => setState(), input({ transcript_path: path.join(tmp, 'missing.jsonl') }), env],
    ['no reply text', () => setState(), input({ last_assistant_message: '' }), env],
  ];
  for (const [name, prep, hookInput, e] of cases) {
    await t.test(name, async () => {
      prep();
      const { ask, calls } = jev([0.1]);
      assert.strictEqual(await check.handle(hookInput, { ask, env: e }), null);
      assert.strictEqual(calls.length, 0);
    });
  }
});

test('handle skips in a project with sizing turned off', async () => {
  setState();
  const project = path.join(tmp, 'proj');
  fs.mkdirSync(path.join(project, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(project, '.claude', 'mynameisjev.json'), JSON.stringify({ router: false }));
  const { ask, calls } = jev([0.1]);
  assert.strictEqual(await check.handle(input({ cwd: project }), { ask, env }), null);
  assert.strictEqual(calls.length, 0);
});

test('handle never blocks when Jev fails, and records the failure', async () => {
  setState();
  const ask = async () => { const e = new Error('aborted'); e.name = 'AbortError'; throw e; };
  assert.strictEqual(await check.handle(input(), { ask, env }), null);
  assert.deepStrictEqual({ ok: readState().lastCall.ok, error: readState().lastCall.error }, { ok: false, error: 'timeout' });
  const bad = async () => ({ answers: {} });
  assert.strictEqual(await check.handle(input(), { ask: bad, env }), null);
});

// Runs the hook as Claude Code does, with fetch stubbed.
test('hook script prints a block decision as JSON', () => {
  setState();
  const stub = path.join(tmp, 'stub-fetch.js');
  fs.writeFileSync(stub, `global.fetch = async (url, opts) => {
    const q = JSON.parse(opts.body).questions;
    const answers = { asks_user: { noul: 0.05 } };
    for (const k of Object.keys(q)) if (k.startsWith('p')) answers[k] = { noul: k === 'p3' ? 0.05 : 0.95 };
    return { ok: true, json: async () => ({ answers, usage: { cost: 0.00003 } }) };
  };`);
  const script = path.join(__dirname, '..', 'plugin', 'scripts', 'jev-check.js');
  const runEnv = { ...process.env, CLAUDE_CONFIG_DIR: claudeDir, HOME: tmp, USERPROFILE: tmp, OPENROUTER_API_KEY: 'sk-test' };
  const out = JSON.parse(execFileSync(process.execPath, ['--require', stub, script], { input: JSON.stringify(input()), env: runEnv }).toString());
  assert.strictEqual(out.decision, 'block');
  assert.match(out.reason, /update the README/);
});

// A transcript whose current turn edits files, after an older turn that
// edited another one.
function editTranscript(prompt, cwd) {
  const file = path.join(tmp, `e-${Math.random().toString(36).slice(2)}.jsonl`);
  const use = (name, input) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', name, input }] } });
  const ok = { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] } };
  const lines = [
    { type: 'user', message: { role: 'user', content: 'an older request' } },
    use('Edit', { file_path: path.join(cwd, 'old.js'), old_string: 'a', new_string: 'older change' }),
    ok,
    { type: 'user', message: { role: 'user', content: prompt } },
    use('Edit', { file_path: path.join(cwd, 'src', 'fetch.js'), old_string: 'x', new_string: 'retry with backoff' }),
    ok,
    use('MultiEdit', { file_path: path.join(cwd, 'src', 'fetch.js'), edits: [{ old_string: 'y', new_string: 'second change' }] }),
    ok,
    use('Write', { file_path: path.join(cwd, 'test', 'fetch.test.js'), content: `test retry; key=sk-or-v1-${'a'.repeat(40)}` }),
    ok,
    use('NotebookEdit', { notebook_path: '/elsewhere/n.ipynb', new_source: 'cell' }),
    ok,
  ];
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return file;
}

test('lastTurn returns the request and only this turn\'s edits, grouped by file', () => {
  const t = check.lastTurn(editTranscript('Add a retry to the fetch helper and test it.', '/proj'), '/proj');
  assert.strictEqual(t.request, 'Add a retry to the fetch helper and test it.');
  assert.deepStrictEqual(t.edits.map((e) => e.file), [path.join('src', 'fetch.js'), path.join('test', 'fetch.test.js'), '/elsewhere/n.ipynb']);
  assert.match(t.edits[0].text, /retry with backoff[\s\S]*second change/);
  assert.ok(!t.edits.some((e) => e.file.includes('old.js')));
});

test('buildRequest sends redacted, clipped edits and one scope question per file', () => {
  const edits = [
    { file: 'a.js', text: `key=sk-or-v1-${'a'.repeat(40)} ${'x'.repeat(2000)}` },
    ...Array.from({ length: 9 }, (_, i) => ({ file: `f${i}.js`, text: 'y' })),
  ];
  const { state, questions, files } = check.buildRequest('Fix the upload bug in a.js.', 'Fixed.', edits);
  assert.match(questions.p1.instructions, /edits made this turn/);
  assert.strictEqual(files.length, check.MAX_FILES);
  assert.deepStrictEqual(Object.keys(questions).filter((k) => /^f\d+$/.test(k)).length, check.MAX_FILES);
  assert.match(questions.f1.instructions, /a\.js/);
  assert.ok(state.edits[0].change.length <= check.EDIT_CHARS);
  assert.deepStrictEqual(state.other_edited_files, ['f7.js', 'f8.js']);
  assert.doesNotMatch(JSON.stringify(state), /aaaaaaaaaa/);
});

test('buildRequest without edits matches the plain check', () => {
  const { state, questions, files } = check.buildRequest('Fix the upload bug in a.js.', 'Fixed.', []);
  assert.deepStrictEqual(files, []);
  assert.strictEqual(state.edits, undefined);
  assert.doesNotMatch(questions.p1.instructions, /edits/);
  assert.deepStrictEqual(Object.keys(questions), ['p1', 'asks_user']);
});

test('unrelatedFiles: below threshold is unrelated; asks_user clears it', () => {
  const files = ['a.js', 'b.js'];
  assert.deepStrictEqual(check.unrelatedFiles({ f1: { noul: 0.9 }, f2: { noul: 0.1 }, asks_user: { noul: 0.1 } }, files), ['b.js']);
  assert.deepStrictEqual(check.unrelatedFiles({ f1: { noul: 0.9 }, f2: { noul: 0.1 }, asks_user: { noul: 0.9 } }, files), []);
});

test('reasonText covers missed parts, unrelated files, or both', () => {
  const both = check.reasonText(['update the README'], ['src/config.js']);
  assert.match(both, /may not cover these parts[\s\S]*- "update the README"[\s\S]*may go beyond the request:\n- src\/config\.js/);
  assert.match(both, /revert unrelated edits/);
  const files = check.reasonText([], ['src/config.js']);
  assert.doesNotMatch(files, /may not cover/);
  assert.match(files, /src\/config\.js/);
  assert.doesNotMatch(check.reasonText(['x part here'], []), /beyond the request/);
});

test('handle blocks on an unrelated file even when every part is covered', async () => {
  setState();
  const cwd = path.join(tmp, 'proj2');
  const calls = [];
  const ask = async (state, questions) => {
    calls.push({ state, questions });
    const answers = { asks_user: { noul: 0.05 } };
    for (const k of Object.keys(questions)) if (/^p\d+$/.test(k)) answers[k] = { noul: 0.9 };
    answers.f1 = { noul: 0.9 };
    answers.f2 = { noul: 0.1 };
    return { answers, usage: { cost: 0.00003 } };
  };
  const out = await check.handle(input({ cwd, transcript_path: editTranscript('Add a retry to the fetch helper.', cwd) }), { ask, env });
  assert.strictEqual(out.decision, 'block');
  assert.match(out.reason, new RegExp(`- ${path.join('test', 'fetch.test.js').replace(/\\/g, '\\\\\\\\')}`));
  assert.doesNotMatch(out.reason, /may not cover/);
  assert.match(out.systemMessage, /1 edited file/);
  assert.strictEqual(readState().stats.checkScope, 1);
  assert.ok(calls[0].state.edits.length >= 2);
});
