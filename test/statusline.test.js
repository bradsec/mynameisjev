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

// Full output with colors kept, for a state, payload and extra environment.
function render(state, input, extraEnv = {}) {
  fs.writeFileSync(path.join(claudeDir, 'mynameisjev', 'state.json'), JSON.stringify(state));
  const env = { ...process.env, CLAUDE_CONFIG_DIR: claudeDir, CODEX_HOME: path.join(tmp, 'codex'), OPENROUTER_API_KEY: 'k', ...extraEnv };
  delete env.NO_COLOR;
  delete env.COLUMNS;
  Object.assign(env, extraEnv);
  return execFileSync(process.execPath, [script], { input: JSON.stringify(input), env, cwd: tmp }).toString();
}
const plain = (t) => t.replace(/\x1b\[[0-9;]*m/g, '');
const later = Math.floor(Date.now() / 1000) + 3600;
const busy = {
  model: { display_name: 'Opus 5.5' },
  context_window: { used_percentage: 40 },
  rate_limits: { five_hour: { used_percentage: 95, resets_at: later }, seven_day: { used_percentage: 20, resets_at: later } },
};

test('NO_COLOR turns colors off; critical usage is bold, not blinking', () => {
  const colored = render({ enabled: true }, busy);
  assert.ok(colored.includes('\x1b['));
  assert.ok(!colored.includes('\x1b[5;'), 'no blink');
  assert.ok(!render({ enabled: true }, busy, { NO_COLOR: '1' }).includes('\x1b['));
});

test('narrow terminals: account goes first, then bar length, then reset times', () => {
  fs.writeFileSync(path.join(claudeDir, '.claude.json'), JSON.stringify({ oauthAccount: { displayName: 'Sam', organizationType: 'claude_max' } }));
  const wide = plain(render({ enabled: true }, busy, { COLUMNS: '300' })).split('\n')[0];
  assert.match(wide, /^Sam · Max │ Opus 5\.5/);
  const cols = (n) => plain(render({ enabled: true }, busy, { COLUMNS: String(n) })).split('\n')[0];
  const noAccount = cols(wide.length - 1);
  assert.match(noAccount, /^Opus 5\.5/);
  assert.match(noAccount, /CTX █{3}░{5}/);
  const compact = cols(noAccount.length - 1);
  assert.match(compact, /CTX ██░░ 40%/);
  assert.match(compact, /↺/);
  const tightest = cols(20);
  assert.doesNotMatch(tightest, /↺/);
  assert.match(tightest, /5H ███ 95%/);
});

test('account info is re-read when ~/.claude.json changes', () => {
  const file = path.join(claudeDir, '.claude.json');
  fs.writeFileSync(file, JSON.stringify({ oauthAccount: { displayName: 'Sam' } }));
  assert.match(plain(render({ enabled: true }, busy)), /^Sam │/);
  fs.writeFileSync(file, JSON.stringify({ oauthAccount: { displayName: 'Alexandra' } }));
  assert.match(plain(render({ enabled: true }, busy)), /^Alexandra │/);
  fs.rmSync(file);
});

test('cold-cache guard shows armed until it has blocked this cold spell', () => {
  const past = Math.floor(Date.now() / 1000) - 60;
  const input = { ...busy, session_id: 's9', prompt_cache: { caching_observed: true, warm: false, expires_at: past, recache_tokens_if_cold: 150000 } };
  assert.match(plain(render({ enabled: true, coldGuard: true }, input)), /cold re-cache 150\.0k guard armed/);
  assert.doesNotMatch(plain(render({ enabled: true, coldGuard: true, coldGuardKey: `s9:${past}` }, input)), /guard armed/);
  assert.doesNotMatch(plain(render({ enabled: true }, input)), /guard armed/);
  const small = { ...input, prompt_cache: { ...input.prompt_cache, recache_tokens_if_cold: 5000 } };
  assert.doesNotMatch(plain(render({ enabled: true, coldGuard: true }, small)), /guard armed/);
});

test('wrap --with-jev adds the JEV segment on its own line', () => {
  const mine = `"${process.execPath.replace(/\\/g, '/')}" -e "process.stdout.write('MINE\\n')"`;
  const out = plain(render({ enabled: true, statusLineMode: 'wrap', statusLineJev: true, previousStatusLine: { type: 'command', command: mine } }, busy));
  assert.strictEqual(out, 'MINE\nJEV on');
});

test('shows when the 5h window runs out at the current pace, and records history', () => {
  const limits = path.join(claudeDir, 'mynameisjev', 'claude-limits.json');
  const now = Date.now();
  const reset = Math.floor(now / 1000) + 3 * 3600;
  fs.writeFileSync(limits, JSON.stringify({ five_hour: { used_percentage: 50, resets_at: reset }, history: [{ at: now - 30 * 60000, pct: 50, reset }] }));
  const out = plain(render({ enabled: true }, { model: { display_name: 'Opus 5.5' }, rate_limits: { five_hour: { used_percentage: 70, resets_at: reset } } }));
  // 50% -> 70% in 30 minutes: 100% in about 45 minutes.
  assert.match(out, /5H ████░░ 70% ↺ \d\d:\d\d →100% ~4\dm/);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(limits, 'utf8')).history.map((s) => s.pct), [50, 70]);
});
