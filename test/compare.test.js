const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const cmp = require('../plugin/scripts/jev-compare');

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jev-compare-')));
const root = path.join(tmp, 'project');
fs.mkdirSync(path.join(root, 'src'), { recursive: true });
const lines = (n, tag) => Array.from({ length: n }, (_, i) => `${tag} line ${i + 1}`).join('\n');
fs.writeFileSync(path.join(root, 'src', 'a.js'), lines(10, 'a'));
fs.writeFileSync(path.join(root, 'src', 'b.js'), lines(10, 'b'));
fs.writeFileSync(path.join(root, 'big.js'), 'x'.repeat(cmp.MAX_VARIANT_CHARS + 1));
fs.writeFileSync(path.join(tmp, 'outside.js'), 'secret stuff');
// Windows without Developer Mode cannot create symlinks; that case is skipped there.
let canLink = true;
try { fs.symlinkSync(path.join(tmp, 'outside.js'), path.join(root, 'link.js')); } catch (e) { canLink = false; }

test('parseRaw splits paths, ranges and criteria', () => {
  assert.deepStrictEqual(cmp.parseRaw('src/a.js src/b.js -- readability, risk'), {
    files: [{ file: 'src/a.js', start: null, end: null }, { file: 'src/b.js', start: null, end: null }],
    criteria: ['readability', 'risk'],
  });
  assert.deepStrictEqual(cmp.parseRaw('x.js:10-40 y.js:5-30').files, [
    { file: 'x.js', start: 10, end: 40 }, { file: 'y.js', start: 5, end: 30 },
  ]);
  assert.deepStrictEqual(cmp.parseRaw('a.js b.js').criteria, []);
});

test('readVariants reads files and line ranges inside the project', () => {
  const v = cmp.readVariants(cmp.parseRaw('src/a.js src/b.js:2-3').files, { root, cwd: root });
  assert.strictEqual(v[0].label, 'a.js');
  assert.match(v[0].text, /a line 10/);
  assert.strictEqual(v[1].label, 'b.js:2-3');
  assert.strictEqual(v[1].text, 'b line 2\nb line 3');
});

test('readVariants labels same-named files by their path', () => {
  fs.mkdirSync(path.join(root, 'other'), { recursive: true });
  fs.writeFileSync(path.join(root, 'other', 'a.js'), 'other a');
  const v = cmp.readVariants(cmp.parseRaw('src/a.js other/a.js').files, { root, cwd: root });
  assert.deepStrictEqual(v.map((x) => x.label), ['src/a.js', 'other/a.js']);
});

test('readVariants refuses files outside the project, by .. or symlink', () => {
  const cases = ['../outside.js src/a.js', `${path.join(tmp, 'outside.js')} src/a.js`];
  if (canLink) cases.push('link.js src/a.js');
  for (const raw of cases) {
    assert.throws(() => cmp.readVariants(cmp.parseRaw(raw).files, { root, cwd: root }), /outside the project/, raw);
  }
});

test('readVariants rejects bad ranges, missing and over-size files', () => {
  const read = (raw) => () => cmp.readVariants(cmp.parseRaw(raw).files, { root, cwd: root });
  assert.throws(read('src/a.js:5-50 src/b.js'), /past the end/);
  assert.throws(read('src/a.js:6-2 src/b.js'), /range/);
  assert.throws(read('src/nope.js src/b.js'), /cannot read/);
  assert.throws(read('big.js src/b.js'), /line range/);
});

test('buildRequest validates counts and builds score and best questions', () => {
  const variants = [{ label: 'a', text: 'code a' }, { label: 'b', text: 'code b' }];
  const { state, questions, criteria } = cmp.buildRequest({ variants, criteria: ['readability', 'risk'] });
  assert.deepStrictEqual(criteria, ['readability', 'risk']);
  assert.deepStrictEqual(Object.keys(questions).sort(), ['best', 'v1_c1', 'v1_c2', 'v2_c1', 'v2_c2']);
  assert.strictEqual(questions.v1_c2.type, 'score');
  assert.strictEqual(questions.v1_c2.criteria.length, 5);
  assert.match(questions.v1_c2.instructions, /risk/);
  assert.match(questions.v1_c2.instructions, /higher is better/i);
  assert.deepStrictEqual(questions.best.criteria, { v1: 'a', v2: 'b' });
  assert.deepStrictEqual(state.variants.map((v) => v.label), ['a', 'b']);
  assert.deepStrictEqual(cmp.buildRequest({ variants }).criteria, cmp.DEFAULT_CRITERIA);

  const bad = [
    { variants: [variants[0]] },
    { variants: Array.from({ length: 5 }, (_, i) => ({ label: `v${i}`, text: 't' })) },
    { variants, criteria: ['a', 'b', 'c', 'd', 'e'] },
    { variants: [{ label: 'a', text: '' }, variants[1]] },
    { variants: [{ label: 'a', text: 'x'.repeat(cmp.MAX_VARIANT_CHARS + 1) }, variants[1]] },
    { variants, context: 'x'.repeat(4001) },
  ];
  for (const input of bad) assert.throws(() => cmp.buildRequest(input), Error, JSON.stringify(input).slice(0, 60));
});

test('buildRequest redacts variant text and context', () => {
  const key = 'sk-or-v1-' + 'a'.repeat(40);
  const { state } = cmp.buildRequest({ variants: [{ label: 'a', text: `k = "${key}"` }, { label: 'b', text: 'x' }], context: key });
  assert.doesNotMatch(JSON.stringify(state), /aaaaaaaaaa/);
});

test('formatResult prints a score table, the best pick and a toss-up note', () => {
  const answers = {
    v1_c1: { score: 3.4 }, v2_c1: { score: 2.9 },
    v1_c2: { score: 2.8 }, v2_c2: { score: 3.62 },
    best: { choice: 'v1', probabilities: { v1: 0.55, v2: 0.45 } },
  };
  const out = cmp.formatResult(['a.js', 'b.js'], ['readability', 'risk'], answers, 0.00004);
  assert.match(out[0], /^\s+a\.js\s+b\.js$/);
  assert.match(out[1], /^readability\s+3\.4\s+2\.9$/);
  assert.match(out[2], /^risk\s+2\.8\s+3\.6$/);
  assert.match(out[3], /^Best: a\.js 0\.55, b\.js 0\.45$/);
  assert.ok(out.some((l) => /toss-up/i.test(l)));
  assert.match(out[out.length - 1], /^Cost: \$0\.00004$/);
  assert.match(out[out.length - 2], /0 = very poor, 4 = very good/);
});

test('formatResult shows a dash for a missing score and rejects a bad best answer', () => {
  const out = cmp.formatResult(['a', 'b'], ['x'], { v1_c1: { score: 2 }, best: { choice: 'v2', probabilities: { v1: 0.1, v2: 0.9 } } }, 0);
  assert.match(out[1], /^x\s+2\.0\s+-$/);
  assert.match(out[2], /^Best: b 0\.90, a 0\.10$/);
  assert.throws(() => cmp.formatResult(['a', 'b'], ['x'], {}, 0), /no answer/i);
});

test('compare reads raw paths and sends one request', async () => {
  const calls = [];
  const ask = async (state, questions, opts) => {
    calls.push({ state, questions, opts });
    return { answers: { v1_c1: { score: 3 }, v2_c1: { score: 1 }, best: { choice: 'v1', probabilities: { v1: 0.9, v2: 0.1 } } }, usage: { cost: 0.00002 } };
  };
  const out = await cmp.compare({ raw: 'src/a.js src/b.js -- clarity' }, 'sk-test', { root, cwd: root, ask });
  assert.strictEqual(calls.length, 1);
  assert.match(calls[0].state.variants[0].text, /a line 1/);
  assert.match(out.join('\n'), /Best: a\.js 0\.90/);
  await assert.rejects(cmp.compare({ raw: 'src/a.js src/b.js' }, '', { root, cwd: root, ask }), /OPENROUTER_API_KEY/);
});

// Runs the CLI as the command does: JSON on stdin, fetch stubbed, paths with
// capitals (jev-cli lowercases its argv, so they must come through stdin).
test('jev-cli compare reads stdin and keeps path case', () => {
  fs.writeFileSync(path.join(root, 'src', 'Upper.js'), 'upper');
  const stub = path.join(tmp, 'stub-fetch.js');
  fs.writeFileSync(stub, `global.fetch = async (url, opts) => ({ ok: true, json: async () => ({ answers: { best: { choice: 'v1', probabilities: { v1: 0.7, v2: 0.3 } } }, usage: { cost: 0 } }) });`);
  const cli = path.join(__dirname, '..', 'plugin', 'scripts', 'jev-cli.js');
  const env = { ...process.env, CLAUDE_CONFIG_DIR: path.join(tmp, 'claude'), CLAUDE_PROJECT_DIR: root, HOME: tmp, USERPROFILE: tmp, OPENROUTER_API_KEY: 'sk-test' };
  const run = (input) => spawnSync(process.execPath, ['--require', stub, cli, 'compare'], { input, env, cwd: root, encoding: 'utf8' });
  const ok = run(JSON.stringify({ raw: 'src/Upper.js src/a.js' }));
  assert.strictEqual(ok.status, 0, ok.stdout + ok.stderr);
  assert.match(ok.stdout, /Best: Upper\.js 0\.70/);
  const bad = run(JSON.stringify({ raw: '../outside.js src/a.js' }));
  assert.strictEqual(bad.status, 1);
  assert.match(bad.stdout, /Error: .*outside the project/);
});
