const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const script = path.join(__dirname, '..', 'plugin', 'scripts', 'cc-statusline.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-statusline-'));
const claudeDir = path.join(tmp, 'claude');
fs.mkdirSync(path.join(claudeDir, 'mynameisjev'), { recursive: true });

// Render the status line with a given router state and key, returning line 1
// without colors.
function line1(state, key, input = '{"model":{"display_name":"Opus 5.5"}}') {
  fs.writeFileSync(path.join(claudeDir, 'mynameisjev', 'state.json'), JSON.stringify(state));
  const env = { ...process.env, CLAUDE_CONFIG_DIR: claudeDir, CODEX_HOME: path.join(tmp, 'codex') };
  delete env.OPENROUTER_API_KEY;
  if (key) env.OPENROUTER_API_KEY = key;
  const out = execFileSync(process.execPath, [script], { input, env, cwd: tmp }).toString();
  return out.split('\n')[0].replace(/\x1b\[[0-9;]*m/g, '');
}

test('router off', () => {
  assert.match(line1({ enabled: false }, 'sk-test'), /JEV off/);
});

test('router on without a key', () => {
  assert.match(line1({ enabled: true }, null), /JEV no key/);
});

test('router on, no call yet', () => {
  assert.match(line1({ enabled: true }, 'sk-test'), /JEV on/);
});

test('router on, last call failed', () => {
  assert.match(line1({ enabled: true, lastCall: { ok: false, error: 'HTTP 401' } }, 'sk-test'), /JEV HTTP 401/);
});

test('router on, last call worked', () => {
  assert.match(line1({ enabled: true, lastCall: { ok: true } }, 'sk-test'), /JEV ✓/);
});

test('route: session model, suggestion, and a hand-off that ran', () => {
  const now = new Date().toISOString();
  const ok = { enabled: true, lastCall: { ok: true } };
  assert.match(line1({ ...ok, route: { at: now, target: 'claude', model: 'opus', how: 'session' } }, 'k'), /JEV ✓ → opus/);
  assert.match(line1({ ...ok, route: { at: now, target: 'codex', model: 'gpt-6-sol', how: 'suggested' } }, 'k'), /→ codex gpt-6-sol\?/);
  assert.match(line1({ ...ok, route: { at: now, target: 'claude', model: 'sonnet', how: 'ran' } }, 'k'), /→ sonnet ✓/);
  assert.match(line1({ ...ok, route: { at: now, target: 'codex', model: 'default', how: 'ran' } }, 'k'), /→ codex ✓/);
});

test('route: hidden after 30 minutes', () => {
  const old = new Date(Date.now() - 31 * 60 * 1000).toISOString();
  assert.doesNotMatch(line1({ enabled: true, lastCall: { ok: true }, route: { at: old, target: 'claude', model: 'opus', how: 'session' } }, 'k'), /→/);
});

test('prefer codex mode is marked', () => {
  assert.match(line1({ enabled: true, lastCall: { ok: true }, prefer: 'codex' }, 'k'), /JEV ✓ codex-first/);
  assert.doesNotMatch(line1({ enabled: true, lastCall: { ok: true } }, 'k'), /codex-first/);
});

test('project config: sizing off, prefer codex, and errors', () => {
  const project = path.join(tmp, 'proj');
  fs.mkdirSync(path.join(project, '.claude'), { recursive: true });
  const cfg = path.join(project, '.claude', 'mynameisjev.json');
  const input = JSON.stringify({ model: { display_name: 'Opus 5.5' }, workspace: { current_dir: project, project_dir: project } });
  fs.writeFileSync(cfg, '{"router": false, "prefer": "codex"}');
  assert.match(line1({ enabled: true }, 'sk-test', input), /JEV off in project codex-first/);
  fs.writeFileSync(cfg, '{"prefer": "codex"}');
  assert.match(line1({ enabled: true }, 'sk-test', input), /JEV on codex-first/);
  fs.writeFileSync(cfg, 'nope');
  assert.match(line1({ enabled: true }, 'sk-test', input), /JEV project config error/);
});

test('shares each session\'s prompt cache expiry for the cold-cache guard', () => {
  const file = path.join(claudeDir, 'mynameisjev', 'prompt-cache.json');
  fs.rmSync(file, { force: true });
  const pc = (over) => JSON.stringify({ model: { display_name: 'Opus 5.5' }, session_id: 'abc', prompt_cache: { caching_observed: true, warm: true, ttl: '1h', expires_at: 2000000000, recache_tokens_if_cold: 120000, ...over } });
  line1({ enabled: true }, 'k', pc({}));
  assert.deepStrictEqual((({ expires_at, ttl, recache }) => ({ expires_at, ttl, recache }))(JSON.parse(fs.readFileSync(file, 'utf8')).abc),
    { expires_at: 2000000000, ttl: '1h', recache: 120000 });
  // No cache tokens in the last reply: expiry kept; after a compaction the size is unknown.
  line1({ enabled: true }, 'k', pc({ warm: false, expires_at: null, recache_tokens_if_cold: null }));
  const saved = JSON.parse(fs.readFileSync(file, 'utf8')).abc;
  assert.strictEqual(saved.expires_at, 2000000000);
  assert.strictEqual(saved.recache, null);
});

// Line 2 without colors, for a payload in `dir`.
function line2(dir) {
  const env = { ...process.env, CLAUDE_CONFIG_DIR: claudeDir, CODEX_HOME: path.join(tmp, 'codex') };
  const input = JSON.stringify({ model: { display_name: 'Opus 5.5' }, cwd: dir, workspace: { current_dir: dir, repo: { owner: 'o', name: 'r' } } });
  const out = execFileSync(process.execPath, [script], { input, env, cwd: dir }).toString();
  return out.split('\n')[1].replace(/\x1b\[[0-9;]*m/g, '');
}

test('git: branch, changed files and upstream counts from one status call', () => {
  const repo = path.join(tmp, 'repo');
  const git = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd: repo, stdio: 'pipe' });
  fs.mkdirSync(repo);
  git('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'a'), '1');
  git('add', 'a');
  git('commit', '-q', '-m', 'one');
  assert.match(line2(repo), /GIT main · clean/);
  fs.writeFileSync(path.join(repo, 'a'), '2');
  fs.writeFileSync(path.join(repo, 'b'), '1');
  assert.match(line2(repo), /GIT main · ~2/);
  // A remote branch one commit behind HEAD: one unpushed commit.
  git('remote', 'add', 'origin', 'https://example.com/o/r.git');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  git('config', 'branch.main.remote', 'origin');
  git('config', 'branch.main.merge', 'refs/heads/main');
  git('commit', '-q', '-am', 'two');
  assert.match(line2(repo), /GIT main · ~1 · ↑1/);
  git('checkout', '-q', '--detach');
  assert.match(line2(repo), /GIT [0-9a-f]{7} · ~1/);
  assert.doesNotMatch(line2(tmp), /GIT/, 'no git segment outside a repo');
});

test('wrap mode prints your status line and still records Jev data', () => {
  const limits = path.join(claudeDir, 'mynameisjev', 'claude-limits.json');
  fs.rmSync(limits, { force: true });
  const mine = `"${process.execPath.replace(/\\/g, '/')}" -e "let s='';process.stdin.on('data',c=>s+=c).on('end',()=>process.stdout.write('MINE '+JSON.parse(s).model.display_name))"`;
  const state = { enabled: true, statusLineMode: 'wrap', previousStatusLine: { type: 'command', command: mine } };
  const input = JSON.stringify({ model: { display_name: 'Opus 5.5' }, rate_limits: { five_hour: { used_percentage: 42, resets_at: 2000000000 } } });
  assert.strictEqual(line1(state, 'k', input), 'MINE Opus 5.5');
  assert.strictEqual(JSON.parse(fs.readFileSync(limits, 'utf8')).five_hour.used_percentage, 42);
});

test('wrap mode: a failing command says so, and never wraps itself', () => {
  const fail = { enabled: true, statusLineMode: 'wrap', previousStatusLine: { type: 'command', command: `"${process.execPath.replace(/\\/g, '/')}" -e "process.exit(3)"` } };
  assert.match(line1(fail, 'k'), /your status line command failed \(exit 3\)/);
  const self = { enabled: true, statusLineMode: 'wrap', previousStatusLine: { type: 'command', command: `"${process.execPath.replace(/\\/g, '/')}" "${script.replace(/\\/g, '/')}"` } };
  assert.match(line1(self, 'k'), /Opus 5\.5 │ JEV/, 'the nested run renders the Jev status line');
});
