#!/usr/bin/env node
// jev-skills — the skills installed in Claude Code, found at run time from
// enabled plugins and ~/.claude/skills, so no skill or plugin name is
// hard-coded. Used to pick an always-on output-style skill (terse replies)
// and mirror its rules into Codex's AGENTS.md (jev-sync.js): Codex has no
// Claude plugin hooks to turn such a mode on.
const fs = require('fs');
const path = require('path');
const os = require('os');
const plugins = require('./jev-plugins');

const claudeDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const BLOCK_START = '<!-- jev-style:start -->';
const BLOCK_END = '<!-- jev-style:end -->';

function scalar(value) {
  if (value.startsWith('"') && value.endsWith('"')) {
    try { return JSON.parse(value); } catch (e) { return value.slice(1, -1); }
  }
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replace(/''/g, "'");
  return value;
}

function readSkill(file, id) {
  try {
    const text = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
    const front = text.match(/^---\n([\s\S]*?)\n---(?:\n|$)/);
    const fields = {};
    const lines = front ? front[1].split('\n') : [];
    for (let i = 0; i < lines.length; i++) {
      const match = lines[i].match(/^(name|description|disable-model-invocation):\s*(.*)$/);
      if (!match) continue;
      let value = match[2].trim();
      if (/^[>|][+-]?(?:\s+#.*)?$/.test(value)) {
        const block = [];
        while (i + 1 < lines.length && /^(\s|$)/.test(lines[i + 1])) block.push(lines[++i].trim());
        value = block.filter(Boolean).join(' ');
      } else {
        value = scalar(value);
      }
      fields[match[1]] = value;
    }
    return {
      id,
      name: fields.name || id,
      description: fields.description || '',
      disableModelInvocation: fields['disable-model-invocation'] === 'true',
      body: (front ? text.slice(front[0].length) : text).trim(),
    };
  } catch (e) {
    return null;
  }
}

function directorySkills(dir, prefix = '') {
  try {
    return fs.readdirSync(dir).map((name) => readSkill(path.join(dir, name, 'SKILL.md'), `${prefix}${name}`)).filter(Boolean);
  } catch (e) {
    return [];
  }
}

function claudeSkills() {
  return [
    ...plugins.claudePlugins().filter((p) => p.enabled && p.installPath)
      .flatMap((p) => directorySkills(path.join(p.installPath, 'skills'), `${p.name}:`)),
    ...directorySkills(path.join(claudeDir, 'skills')),
  ];
}

// Skills that set a terse reply style and stay on, judged from their own
// descriptions. Skills that only run when typed (disable-model-invocation)
// are left out: those are variants of a mode, not the mode itself.
function outputStyleCandidates() {
  return claudeSkills().filter((s) => !s.disableModelInvocation &&
    /\b(terse|concise|brevity|be brief|less tokens|fewer tokens)\b/i.test(s.description) &&
    /\bstays on\b|\balways[- ]on\b|\buntil\b/i.test(s.description));
}

function outputStyle(setting) {
  if (setting === null || setting === false || setting === undefined) return { skill: null, reason: 'off' };
  if (setting === 'auto') {
    const candidates = outputStyleCandidates();
    if (candidates.length === 1) return { skill: candidates[0] };
    return { skill: null, candidates, reason: candidates.length ? 'several found; pick one with /mynameisjev:style <id>' : 'none found' };
  }
  const skill = claudeSkills().find((s) => s.id === setting);
  return skill ? { skill } : { skill: null, reason: `${setting} not found or its plugin is disabled` };
}

function codexBlock(skill) {
  return [
    BLOCK_START,
    `## Output style (always on, from the ${skill.id} skill)`,
    '',
    'Applies to your replies and final summaries. Code, commands, commit messages, and file contents stay normal.',
    '',
    skill.body,
    BLOCK_END,
  ].join('\n');
}

function codexStatus() {
  if (!fs.existsSync(codexHome)) return 'no-codex';
  try {
    const text = fs.readFileSync(path.join(codexHome, 'AGENTS.md'), 'utf8');
    const start = text.indexOf(BLOCK_START);
    if (start !== -1 && text.indexOf(BLOCK_END, start) !== -1) return 'active';
  } catch (e) { /* no readable block */ }
  return 'missing';
}

module.exports = { claudeSkills, outputStyleCandidates, outputStyle, codexBlock, codexStatus };
