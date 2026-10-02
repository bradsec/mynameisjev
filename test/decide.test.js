const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { parseRaw, buildRequest, formatResult, decide, TOSS_UP_GAP } = require('../plugin/scripts/jev-decide');

test('parseRaw splits options on | and criteria after --', () => {
  assert.deepStrictEqual(parseRaw('zod | valibot -- bundle size, DX'), { options: ['zod', 'valibot'], criteria: 'bundle size, DX' });
  assert.deepStrictEqual(parseRaw(' a|b | c '), { options: ['a', 'b', 'c'], criteria: '' });
  assert.deepStrictEqual(parseRaw('a | | b --'), { options: ['a', 'b'], criteria: '' });
});

test('parseRaw keeps -- inside an option name, splitting on the first " -- " only', () => {
  assert.deepStrictEqual(parseRaw('--force | --dry-run -- safety -- speed'), { options: ['--force', '--dry-run'], criteria: 'safety -- speed' });
});

test('buildRequest turns raw args into one choice question keyed o1..oN', () => {
  const { state, questions, options } = buildRequest({ raw: 'zod | valibot -- bundle size' });
  assert.deepStrictEqual(options, ['zod', 'valibot']);
  assert.deepStrictEqual(Object.keys(questions), ['pick']);
  assert.strictEqual(questions.pick.type, 'choice');
  assert.deepStrictEqual(questions.pick.criteria, { o1: 'zod', o2: 'valibot' });
  assert.match(questions.pick.instructions, /bundle size/);
  assert.strictEqual(state.context, undefined);
});

test('buildRequest uses question, criteria and context from structured input', () => {
  const { state, questions } = buildRequest({
    question: 'Which fix for the retry bug?',
    options: ['backoff in fetch helper', 'retry at call site'],
    criteria: 'least code',
    context: 'Goal: stop flaky uploads.',
  });
  assert.match(questions.pick.instructions, /Which fix for the retry bug\?/);
  assert.match(questions.pick.instructions, /least code/);
  assert.strictEqual(state.context, 'Goal: stop flaky uploads.');
});

test('buildRequest redacts secrets in everything sent', () => {
  const key = 'sk-or-v1-' + 'a'.repeat(40);
  const { state, questions } = buildRequest({ options: ['use ' + key, 'b'], context: `key=${key}` });
  assert.doesNotMatch(JSON.stringify({ state, questions }), /aaaaaaaaaa/);
});

test('buildRequest rejects bad input with a usage message', () => {
  const bad = [
    {},
    { raw: 'only-one' },
    { options: ['a'] },
    { options: ['a', 'a'] },
    { options: ['a', 42] },
    { options: Array.from({ length: 9 }, (_, i) => `o${i}`) },
    { options: ['a', 'x'.repeat(201)] },
    { options: ['a', 'b'], context: 'x'.repeat(16001) },
    { options: ['a', 'b'], question: 'q'.repeat(1001) },
  ];
  for (const input of bad) assert.throws(() => buildRequest(input), /usage|option|context|question/i, JSON.stringify(input).slice(0, 80));
});

test('formatResult sorts options by probability and marks a clear pick', () => {
  const lines = formatResult(['zod', 'valibot'], { choice: 'o2', probabilities: { o1: 0.29, o2: 0.71 } }, 0.00002);
  assert.match(lines[0], /^Pick: valibot\s+0\.71$/);
  assert.match(lines[1], /^\s+zod\s+0\.29$/);
  assert.ok(!lines.some((l) => /toss-up/i.test(l)));
  assert.match(lines[lines.length - 1], /^Cost: \$0\.00002$/);
});

test('formatResult flags a toss-up when the top two are close', () => {
  const close = formatResult(['a', 'b', 'c'], { choice: 'o1', probabilities: { o1: 0.45, o2: 0.4, o3: 0.15 } }, 0);
  assert.ok(close.some((l) => /toss-up/i.test(l)));
  const gap = 0.5 + TOSS_UP_GAP / 2;
  const clear = formatResult(['a', 'b'], { choice: 'o1', probabilities: { o1: gap + TOSS_UP_GAP, o2: 1 - gap - TOSS_UP_GAP } }, 0);
  assert.ok(!clear.some((l) => /toss-up/i.test(l)));
});

test('formatResult rejects an answer that names no known option', () => {
  assert.throws(() => formatResult(['a', 'b'], { choice: 'o9', probabilities: {} }, 0), /unexpected/i);
  assert.throws(() => formatResult(['a', 'b'], undefined, 0), /no answer/i);
});

test('decide sends one request and formats the answer', async () => {
  const calls = [];
  const ask = async (state, questions, opts) => {
    calls.push({ state, questions, opts });
    return { answers: { pick: { choice: 'o1', confidence: 0.8, probabilities: { o1: 0.8, o2: 0.2 } } }, usage: { cost: 0.00003 } };
  };
  const lines = await decide({ raw: 'a | b' }, 'sk-test', ask);
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].opts.apiKey, 'sk-test');
  assert.match(lines[0], /^Pick: a/);
});

test('decide refuses without an API key, before any request', async () => {
  let called = false;
  await assert.rejects(decide({ raw: 'a | b' }, '', async () => { called = true; }), /OPENROUTER_API_KEY/);
  assert.strictEqual(called, false);
});

// Runs the CLI as the command does: JSON on stdin, fetch stubbed.
test('jev-cli decide reads stdin, prints the pick, and exits 1 on bad input', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-decide-'));
  const stub = path.join(tmp, 'stub-fetch.js');
  fs.writeFileSync(stub, `global.fetch = async (url, opts) => ({ ok: true, json: async () => ({ answers: { pick: { choice: 'o2', probabilities: { o1: 0.1, o2: 0.9 } } }, usage: { cost: 0.00002 } }) });`);
  const cli = path.join(__dirname, '..', 'plugin', 'scripts', 'jev-cli.js');
  const env = { ...process.env, CLAUDE_CONFIG_DIR: path.join(tmp, 'claude'), HOME: tmp, USERPROFILE: tmp, OPENROUTER_API_KEY: 'sk-test' };
  const run = (input) => spawnSync(process.execPath, ['--require', stub, cli, 'decide'], { input, env, encoding: 'utf8' });

  const ok = run(JSON.stringify({ raw: 'Zod | Valibot' }));
  assert.strictEqual(ok.status, 0, ok.stdout + ok.stderr);
  assert.match(ok.stdout, /Pick: Valibot\s+0\.90/);

  const bad = run('not json');
  assert.strictEqual(bad.status, 1);
  assert.match(bad.stdout, /Error:/);
});

test('decide reports a timeout in plain words', async () => {
  const ask = async () => { const e = new Error('aborted'); e.name = 'AbortError'; throw e; };
  await assert.rejects(decide({ raw: 'a | b' }, 'sk-test', ask), /did not answer within 15s/);
});
