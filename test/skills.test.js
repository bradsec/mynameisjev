const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-skills-'));
process.env.CLAUDE_CONFIG_DIR = path.join(tmp, 'claude');
process.env.CODEX_HOME = path.join(tmp, 'codex');
const claudeDir = process.env.CLAUDE_CONFIG_DIR;
const pluginDir = path.join(tmp, 'plugin');
const write = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};
const skillFile = (dir, name, description, extra = '') => write(path.join(dir, name, 'SKILL.md'),
  `---\nname: '${name}'\ndescription: ${description}\n${extra}---\n\n# ${name}\n\nKeep facts.\n`);
const description = 'Terse caveman voice: answer first, fluff gone, every technical fact kept. Use for /caveman, "caveman mode", "talk like caveman", "be brief", "less tokens". Stays on until "stop caveman" or "normal mode".';
write(path.join(claudeDir, 'plugins', 'installed_plugins.json'), JSON.stringify({ plugins: {
  'voice@local': [{ installPath: pluginDir, version: '1.0' }],
  'disabled@local': [{ installPath: path.join(tmp, 'disabled'), version: '1.0' }],
} }));
write(path.join(claudeDir, 'settings.json'), JSON.stringify({ enabledPlugins: { 'voice@local': true } }));
skillFile(path.join(pluginDir, 'skills'), 'caveman', description);
skillFile(path.join(pluginDir, 'skills'), 'ultracave', description, 'disable-model-invocation: true\n');
skillFile(path.join(pluginDir, 'skills'), 'caveman-compress', 'Compress a memory file into caveman format to save input tokens');
skillFile(path.join(pluginDir, 'skills'), 'caveman-commit', 'Write a concise commit message');
skillFile(path.join(tmp, 'disabled', 'skills'), 'hidden', 'Concise output. Always-on.');
skillFile(path.join(claudeDir, 'skills'), 'folded', '>\n  Describe code\n  across lines.');
skillFile(path.join(claudeDir, 'skills'), 'literal', '|\n  Describe tests\n  across lines.');
skillFile(path.join(tmp, 'linked'), 'user', '"A user skill"');
fs.mkdirSync(path.join(claudeDir, 'skills'), { recursive: true });
fs.symlinkSync(path.join(tmp, 'linked', 'user'), path.join(claudeDir, 'skills', 'user'));
fs.symlinkSync(path.join(tmp, 'absent'), path.join(claudeDir, 'skills', 'broken'));

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('discovers enabled plugin and user skills, follows links, and parses descriptions', () => {
  const skills = require('../plugin/scripts/jev-skills').claudeSkills();
  assert.equal(skills.find((s) => s.id === 'voice:caveman').description, description);
  assert.equal(skills.find((s) => s.id === 'folded').description, 'Describe code across lines.');
  assert.equal(skills.find((s) => s.id === 'literal').description, 'Describe tests across lines.');
  assert.equal(skills.find((s) => s.id === 'user').name, 'user');
  assert.equal(skills.find((s) => s.id === 'user').description, 'A user skill');
  assert.ok(!skills.some((s) => s.id === 'disabled:hidden' || s.id === 'broken'));
});

test('candidates require persistent output style and exclude invocation aliases', () => {
  const skills = require('../plugin/scripts/jev-skills');
  assert.deepEqual(skills.outputStyleCandidates().map((s) => s.id), ['voice:caveman']);
});

test('selects off, auto, explicit, missing and ambiguous styles from current installs', () => {
  const skills = require('../plugin/scripts/jev-skills');
  assert.deepEqual(skills.outputStyle(null), { skill: null, reason: 'off' });
  assert.deepEqual(skills.outputStyle(false), { skill: null, reason: 'off' });
  assert.equal(skills.outputStyle('auto').skill.id, 'voice:caveman');
  assert.equal(skills.outputStyle('user').skill.id, 'user');
  assert.deepEqual(skills.outputStyle('disabled:hidden'), { skill: null, reason: 'disabled:hidden not found or its plugin is disabled' });
  assert.equal(skills.outputStyle('absent').skill, null);
  skillFile(path.join(claudeDir, 'skills'), 'second', "'Concise output, always-on until stopped.'");
  const several = skills.outputStyle('auto');
  assert.equal(several.skill, null);
  assert.equal(several.reason, 'several found; pick one with /mynameisjev:style <id>');
  assert.equal(several.candidates.length, 2);
  fs.rmSync(path.join(claudeDir, 'skills', 'second'), { recursive: true });
  write(path.join(claudeDir, 'settings.json'), '{}');
  assert.deepEqual(skills.outputStyle('auto'), { skill: null, candidates: [], reason: 'none found' });
  write(path.join(claudeDir, 'settings.json'), JSON.stringify({ enabledPlugins: { 'voice@local': true } }));
});

test('Codex block contains body without frontmatter, and status tracks the block', () => {
  const skills = require('../plugin/scripts/jev-skills');
  const block = skills.codexBlock(skills.outputStyle('auto').skill);
  assert.match(block, /^<!-- jev-style:start -->\n## Output style \(always on, from the voice:caveman skill\)/);
  assert.match(block, /Applies to your replies and final summaries\. Code, commands, commit messages, and file contents stay normal\./);
  assert.match(block, /# caveman\n\nKeep facts\.\n<!-- jev-style:end -->$/);
  assert.doesNotMatch(block, /description:|name:/);
  assert.equal(skills.codexStatus(), 'no-codex');
  fs.mkdirSync(process.env.CODEX_HOME);
  assert.equal(skills.codexStatus(), 'missing');
  write(path.join(process.env.CODEX_HOME, 'AGENTS.md'), '<!-- jev-style:start -->');
  assert.equal(skills.codexStatus(), 'missing');
  write(path.join(process.env.CODEX_HOME, 'AGENTS.md'), block);
  assert.equal(skills.codexStatus(), 'active');
});
