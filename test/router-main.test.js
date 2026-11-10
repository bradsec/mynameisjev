// Runs the router hook as Claude Code does, with fetch stubbed, to check what
// leaves the machine and what the hook prints.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const script = path.join(__dirname, '..', 'plugin', 'scripts', 'jev-router.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-main-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const claudeDir = path.join(tmp, 'claude');
const dataDir = path.join(claudeDir, 'mynameisjev');
const project = path.join(tmp, 'project');
const sent = path.join(tmp, 'sent.json');
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(path.join(project, '.claude'), { recursive: true });

// Preloaded into the hook: records each request body and answers like Jev.
const stub = path.join(tmp, 'stub-fetch.js');
fs.writeFileSync(stub, `
const fs = require('fs');
global.fetch = async (url, opts) => {
  fs.appendFileSync(${JSON.stringify(sent)}, opts.body + '\\n');
  const size = process.env.JEV_STUB_SIZE ? JSON.parse(process.env.JEV_STUB_SIZE) : { choice: 'everyday', confidence: 0.9 };
  return { ok: true, json: async () => ({ answers: { size, contained: { noul: 0.9 }, heavy: { noul: 0.1 }, coding: { noul: 0.1 }, effort: { score: 0.2 }, ...(process.env.JEV_STUB_MODEL ? { model: JSON.parse(process.env.JEV_STUB_MODEL) } : {}), ...(process.env.JEV_STUB_SELF ? { self: { noul: 0.9 } } : {}), ...(process.env.JEV_STUB_SHIFT ? { shift: { noul: 0.95 } } : {}) }, usage: { cost: 0.00002 } }) };
};
`);

function run(prompt, { key = 'sk-test', config, state: over = {}, keepState = false, size, model, self = false, shift = false, session = 's1' } = {}) {
  if (!keepState) fs.writeFileSync(path.join(dataDir, 'state.json'), JSON.stringify({ enabled: true, ...over }));
  const cfg = path.join(project, '.claude', 'mynameisjev.json');
  if (config === undefined) fs.rmSync(cfg, { force: true });
  else fs.writeFileSync(cfg, config);
  fs.rmSync(sent, { force: true });
  const env = { ...process.env, CLAUDE_CONFIG_DIR: claudeDir, CODEX_HOME: path.join(tmp, 'codex'), CLAUDE_PROJECT_DIR: project, HOME: tmp, USERPROFILE: tmp };
  delete env.OPENROUTER_API_KEY;
  if (key) env.OPENROUTER_API_KEY = key;
  if (size) env.JEV_STUB_SIZE = JSON.stringify(size);
  // A bare name is a confident answer; pass an object to set the confidence.
  if (model) env.JEV_STUB_MODEL = JSON.stringify(typeof model === 'string' ? { choice: model, confidence: 0.9 } : model);
  if (self) env.JEV_STUB_SELF = '1';
  if (shift) env.JEV_STUB_SHIFT = '1';
  const input = JSON.stringify({ prompt, session_id: session, cwd: project });
  const out = execFileSync(process.execPath, ['--require', stub, script], { input, env }).toString();
  const bodies = fs.existsSync(sent) ? fs.readFileSync(sent, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
  const state = JSON.parse(fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8'));
  return { out: out ? JSON.parse(out) : {}, bodies, state };
}

test('secrets are redacted from the Jev request and the stored prompt', () => {
  const secret = `sk-or-v1-${'a'.repeat(40)}`;
  const r = run(`Write a script that calls the API with key ${secret} and prints the result.`);
  assert.strictEqual(r.bodies.length, 1);
  const body = JSON.stringify(r.bodies[0]);
  assert.ok(!body.includes(secret), 'key sent to Jev');
  assert.match(body, /\[REDACTED\]/);
  assert.ok(!r.state.lastPrompt.text.includes(secret), 'key stored in state');
  assert.strictEqual(r.bodies[0].model, 'typesafe/jev-1.14');
});

test('a size answer without a confidence counts as unsure, not failed', () => {
  const r = run('Write a short email to my landlord about the faucet.', { size: { choice: 'everyday' } });
  assert.strictEqual(r.state.stats.unsure, 1);
  assert.strictEqual(r.state.stats.everyday, 0);
  assert.strictEqual(r.state.stats.failed, 0);
  assert.match(r.state.lastSilent.reason, /no confidence/);
});

test('project config router:false sends nothing', () => {
  const r = run('Write a short email to my landlord about the faucet.', { config: '{"router": false}' });
  assert.strictEqual(r.bodies.length, 0);
  assert.match(r.state.lastSilent.reason, /sizing off for this project/);
});

test('an unusable project config fails closed and tells the user once', () => {
  const r = run('Write a short email to my landlord about the faucet.', { config: '{"router": fals' });
  assert.strictEqual(r.bodies.length, 0);
  assert.match(r.out.systemMessage, /is not usable \(invalid JSON/);
});

test('project prefer codex overrides the global setting', () => {
  // No Codex here, so prefer only shows in the status line; check it parses.
  const st = require('../plugin/scripts/jev-state');
  fs.writeFileSync(path.join(project, '.claude', 'mynameisjev.json'), '{"prefer": "codex"}');
  assert.deepStrictEqual(st.readProjectConfig(project), { path: path.join(project, '.claude', 'mynameisjev.json'), router: true, prefer: 'codex', error: null });
  fs.writeFileSync(path.join(project, '.claude', 'mynameisjev.json'), '{"prefer": "gpt"}');
  assert.match(st.readProjectConfig(project).error, /"prefer" must be/);
  fs.rmSync(path.join(project, '.claude', 'mynameisjev.json'));
  assert.strictEqual(st.readProjectConfig(project), null);
});

test('overrides skip Jev, work without a key and in projects with sizing off', () => {
  const r = run('+large research the options and write a report', { key: null, config: '{"router": false}' });
  assert.strictEqual(r.bodies.length, 0);
  assert.match(r.out.hookSpecificOutput.additionalContext, /"mynameisjev:large" subagent/);
  assert.strictEqual(r.state.stats.forced, 1);
  assert.deepStrictEqual([r.state.route.target, r.state.route.model, r.state.route.how], ['claude', 'opus', 'suggested']);
});

test('helper notes are counted', () => {
  // Session model unknown: the note suggests the everyday helper.
  const r = run('Write a short email to my landlord about the faucet.');
  assert.strictEqual(r.bodies.length, 1);
  assert.strictEqual(r.state.stats.helper, 1);
});

test('cold-cache guard blocks once per expiry, never slash commands, only when on', () => {
  const expired = Math.floor(Date.now() / 1000) - 600;
  fs.writeFileSync(path.join(dataDir, 'prompt-cache.json'), JSON.stringify({ s1: { expires_at: expired, ttl: '5m', recache: 150000 } }));
  const msg = 'Write a short email to my landlord about the faucet.';

  const off = run(msg);
  assert.strictEqual(off.out.decision, undefined);

  const blocked = run(msg, { state: { coldGuard: true } });
  assert.strictEqual(blocked.out.decision, 'block');
  assert.match(blocked.out.reason, /about 150k tokens/);
  assert.strictEqual(blocked.bodies.length, 0, 'no Jev call for a blocked message');

  const again = run(msg, { keepState: true });
  assert.strictEqual(again.out.decision, undefined, 'the resend goes through');
  assert.strictEqual(again.bodies.length, 1);

  const slash = run('/compact keep the API notes', { state: { coldGuard: true } });
  assert.strictEqual(slash.out.decision, undefined);
  fs.rmSync(path.join(dataDir, 'prompt-cache.json'));
});

test('cold-cache guard does not reblock one session after another blocks', () => {
  const expired = Math.floor(Date.now() / 1000) - 600;
  fs.writeFileSync(path.join(dataDir, 'prompt-cache.json'), JSON.stringify({
    s1: { expires_at: expired, ttl: '5m', recache: 150000 },
    s2: { expires_at: expired, ttl: '5m', recache: 150000 },
  }));
  const msg = 'Write a short email to my landlord about the faucet.';
  assert.strictEqual(run(msg, { state: { coldGuard: true } }).out.decision, 'block');
  assert.strictEqual(run(msg, { keepState: true, session: 's2' }).out.decision, 'block');
  assert.strictEqual(run(msg, { keepState: true }).out.decision, undefined);
  fs.rmSync(path.join(dataDir, 'prompt-cache.json'));
});

test('every prompt sets promptAt, for the tiebreak cap', () => {
  const sized = run('Write a short email to my landlord about the faucet.', { state: { promptAt: '2000-01-01T00:00:00.000Z' } });
  assert.notStrictEqual(sized.state.promptAt, '2000-01-01T00:00:00.000Z');
  const skipped = run('ok', { state: { promptAt: '2000-01-01T00:00:00.000Z' } });
  assert.notStrictEqual(skipped.state.promptAt, '2000-01-01T00:00:00.000Z');
});

test('the Jev request asks the effort question with four levels', () => {
  const r = run('Write a short email to my landlord about the faucet.');
  const q = r.bodies[0].questions.effort;
  assert.strictEqual(q.type, 'score');
  assert.strictEqual(q.criteria.length, 4);
});

test('eligible prompts send seven questions, eight with prior context; skipped prompts send none', () => {
  const first = run('Write a short email to my landlord about the faucet.');
  assert.strictEqual(Object.keys(first.bodies[0].questions).length, 7);
  const next = run('Now revise that email to mention the leaking pipe.', { keepState: true });
  assert.strictEqual(Object.keys(next.bodies[0].questions).length, 8);
  assert.strictEqual(run('/mynameisjev:status').bodies.length, 0);
});

test('model question asks for explicit work requests, not name mentions', () => {
  const q = run('Write a fable about an astronaut.').bodies[0].questions.model;
  assert.strictEqual(q.type, 'choice');
  assert.deepStrictEqual(Object.keys(q.criteria), ['none', 'fable', 'astra']);
  assert.match(q.criteria.none, /mention/);
  // The live classifier cannot be called here, so check the text it is given:
  // each case that must answer "none" is named, and a request must be the
  // user's own.
  assert.match(q.instructions, /in their own words/);
  for (const excluded of [/quoted or pasted/, /log, email, code/, /someone else's words/, /"don't use fable"/, /a story/, /Fable compiler/, /Astra DB/]) {
    assert.match(q.criteria.none, excluded);
  }
  for (const name of ['fable', 'astra']) assert.match(q.criteria[name], /^the user asks the \w+ model to do this work/);
  // Sent with every sized prompt, so it stays short.
  assert.ok(JSON.stringify(q).length < 560, `model question is ${JSON.stringify(q).length} characters`);
});

test('classifier routes explicit Fable, and self keeps work in session', () => {
  const asked = run('Use fable to write the report.', { model: 'fable' });
  assert.deepStrictEqual([asked.state.route.target, asked.state.route.model, asked.state.route.how], ['claude', 'fable', 'suggested']);
  assert.match(asked.out.hookSpecificOutput.additionalContext, /model: "fable"/);
  const self = run('Use fable, but do it yourself.', { model: 'fable', self: true });
  assert.strictEqual(self.state.route.how, 'session');
  assert.strictEqual(self.out.hookSpecificOutput, undefined);
});

test('classifier Astra routes like prefix; none and missing answer do not', () => {
  const asked = run('Have astra do this coding task.', { model: 'astra' });
  assert.strictEqual(asked.state.route.target, 'claude');
  assert.match(asked.out.systemMessage, /Codex is not available/);
  for (const model of ['none', undefined]) {
    const r = run('Write a fable about an astronaut.', { model });
    assert.notStrictEqual(r.state.route.model, 'fable');
    assert.strictEqual(Boolean(r.out.systemMessage?.includes('Codex is not available')), false);
  }
});

test('prefix wins over classifier and skips its call', () => {
  const r = run('+fable have astra do it', { model: 'astra' });
  assert.strictEqual(r.bodies.length, 0);
  assert.strictEqual(r.state.route.model, 'fable');
});

test('sizing calls record their cost under sizing', () => {
  const r = run('Write a short email to my landlord about the faucet.');
  assert.deepStrictEqual(r.state.costs.sizing, { calls: 1, cost: 0.00002 });
});

test('a short message naming Fable or Astra still reaches the classifier; other short messages and slash commands do not', () => {
  for (const [prompt, model] of [['have Astra do it', 'astra'], ['use fable for this', 'fable'], ['ok, use fable for this one', 'fable']]) {
    const r = run(prompt, { model });
    assert.strictEqual(r.bodies.length, 1, prompt);
    assert.ok(r.out.hookSpecificOutput || r.out.systemMessage, prompt);
  }
  const fable = run('use fable for this', { model: 'fable' });
  assert.deepStrictEqual([fable.state.route.target, fable.state.route.model, fable.state.route.how], ['claude', 'fable', 'suggested']);
  assert.notStrictEqual(run('a fable please', { model: 'none' }).state.route.model, 'fable');
  for (const prompt of ['short one', 'yes do that please', '/model fable', 'fabled astral']) {
    assert.strictEqual(run(prompt, { model: 'fable' }).bodies.length, 0, prompt);
  }
});

test('a model answer below the confidence gate, or with none, is treated as no request', () => {
  for (const model of [{ choice: 'fable', confidence: 0.05 }, { choice: 'fable', confidence: 0.59 }, { choice: 'fable' }, { choice: 'astra', confidence: 0.3 }]) {
    const r = run('Write a fable about an astronaut for the newsletter.', { model });
    assert.notStrictEqual(r.state.route.model, 'fable', JSON.stringify(model));
    assert.strictEqual(r.state.stats.everyday, 1, JSON.stringify(model));
    assert.strictEqual(Boolean(r.out.systemMessage?.includes('Codex is not available')), false);
  }
  const sure = run('Use fable to write the report.', { model: { choice: 'fable', confidence: 0.6 } });
  assert.strictEqual(sure.state.route.model, 'fable');
});

test('a plain-language model request keeps the new-task notice and is not counted as a "+" override', () => {
  run('Write a short email to my landlord about the faucet.');
  const r = run('Use fable to plan the database migration.', { keepState: true, model: 'fable', shift: true });
  assert.strictEqual(r.state.route.model, 'fable');
  assert.match(r.out.systemMessage, /looks like a new task/);
  assert.strictEqual(r.state.stats.shift, 1);
  assert.strictEqual(r.state.stats.forced, 0);
  assert.strictEqual(r.state.stats.helper, 2);
  const prefixed = run('+fable plan the database migration', { model: 'fable' });
  assert.strictEqual(prefixed.state.stats.forced, 1);
  assert.strictEqual(prefixed.state.stats.helper, 0);
});

test('a skipped AGENTS.md sync is reported once per session, except when Codex is not installed', () => {
  const codexHome = path.join(tmp, 'codex');
  const sync = { sync: true };
  // No Codex home: nothing to sync to, so nothing to say.
  assert.doesNotMatch(run('ok', { state: sync }).out.systemMessage || '', /AGENTS\.md/);
  fs.mkdirSync(codexHome, { recursive: true });
  try {
    const first = run('ok', { state: sync });
    assert.match(first.out.systemMessage, /Jev: ~\/\.codex\/AGENTS\.md was not regenerated \(no CLAUDE\.md\)/);
    assert.doesNotMatch(run('ok', { state: sync, keepState: true }).out.systemMessage || '', /AGENTS\.md/);
    assert.match(run('ok', { state: sync, keepState: true, session: 's2' }).out.systemMessage, /not regenerated \(no CLAUDE\.md\)/);
    // Back in the first session after the other one's notice: still quiet.
    assert.doesNotMatch(run('ok', { state: sync, keepState: true }).out.systemMessage || '', /AGENTS\.md/);
    assert.doesNotMatch(run('ok', { state: { sync: false } }).out.systemMessage || '', /AGENTS\.md/);
  } finally {
    fs.rmSync(codexHome, { recursive: true, force: true });
  }
});

test('classifier Astra with Codex available routes to the frontier model and counts as a Codex note', () => {
  // Fake Codex: enabled plugin, a companion script, a codex executable on
  // PATH (with the .cmd form Windows looks for), and a fresh model list.
  const companion = path.join(claudeDir, 'plugins', 'cache', 'openai-codex', 'codex', '1.0.0', 'scripts');
  const bin = path.join(tmp, 'bin');
  const cache = path.join(dataDir, 'codex-cache.json');
  const settings = path.join(claudeDir, 'settings.json');
  const oldPath = process.env.PATH;
  fs.mkdirSync(companion, { recursive: true });
  fs.writeFileSync(path.join(companion, 'codex-companion.mjs'), '');
  fs.writeFileSync(settings, JSON.stringify({ enabledPlugins: { 'codex@openai-codex': true } }));
  fs.mkdirSync(bin, { recursive: true });
  for (const name of ['codex', 'codex.cmd']) fs.writeFileSync(path.join(bin, name), '', { mode: 0o755 });
  process.env.PATH = `${bin}${path.delimiter}${oldPath}`;
  fs.writeFileSync(cache, JSON.stringify({
    at: Date.now(),
    limits: { ordinaryUsageAllowed: true, primary: { usedPercent: 5 }, secondary: { usedPercent: 10 } },
    models: [
      { id: 'gpt-6.1-sol', description: 'Latest workhorse model.', isDefault: true },
      { id: 'gpt-6-astra', description: 'Frontier intelligence.' },
      { id: 'gpt-6-luna', description: 'Fast and affordable model.' },
    ],
  }));
  try {
    const r = run('Have astra do this coding task.', { model: 'astra' });
    assert.strictEqual(r.bodies.length, 1);
    assert.deepStrictEqual([r.state.route.target, r.state.route.model, r.state.route.how], ['codex', 'gpt-6-astra', 'suggested']);
    assert.match(r.out.hookSpecificOutput.additionalContext, /The user explicitly requested this model.*Route it to Codex/s);
    assert.match(r.out.hookSpecificOutput.additionalContext, /task --model gpt-6-astra --effort high/);
    assert.strictEqual(r.out.systemMessage, undefined);
    assert.strictEqual(r.state.stats.codex, 1);
    assert.strictEqual(r.state.stats.forced, 0);
    assert.strictEqual(r.state.stats.helper, 0);
    assert.ok(r.state.sessions.s1.guided, 'session marked as holding the full Codex brief');
    // A request to do it in this session still wins.
    const self = run('Have astra do it, but do it yourself.', { model: 'astra', self: true });
    assert.strictEqual(self.state.route.target, 'claude');
    assert.strictEqual(self.state.stats.codex, 0);
  } finally {
    process.env.PATH = oldPath;
    for (const p of [cache, settings, bin, path.join(claudeDir, 'plugins')]) fs.rmSync(p, { recursive: true, force: true });
  }
});
