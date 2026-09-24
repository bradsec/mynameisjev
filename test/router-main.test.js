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
  return { ok: true, json: async () => ({ answers: { size: { choice: 'everyday', confidence: 0.9 }, contained: { noul: 0.9 }, heavy: { noul: 0.1 }, coding: { noul: 0.1 } }, usage: { cost: 0.00002 } }) };
};
`);

function run(prompt, { key = 'sk-test', config } = {}) {
  fs.writeFileSync(path.join(dataDir, 'state.json'), JSON.stringify({ enabled: true }));
  const cfg = path.join(project, '.claude', 'mynameisjev.json');
  if (config === undefined) fs.rmSync(cfg, { force: true });
  else fs.writeFileSync(cfg, config);
  fs.rmSync(sent, { force: true });
  const env = { ...process.env, CLAUDE_CONFIG_DIR: claudeDir, CODEX_HOME: path.join(tmp, 'codex'), CLAUDE_PROJECT_DIR: project, HOME: tmp, USERPROFILE: tmp };
  delete env.OPENROUTER_API_KEY;
  if (key) env.OPENROUTER_API_KEY = key;
  const input = JSON.stringify({ prompt, session_id: 's1', cwd: project });
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
