#!/usr/bin/env node
// jev-caveman — keeps caveman (terse output mode) active on both sides of the
// Jev router: the caveman plugin in Claude Code, and a caveman block in
// Codex's always-loaded ~/.codex/AGENTS.md (placed by jev-sync.js, which
// generates that file).
//
// Codex gets an AGENTS.md block rather than caveman's Codex skill because the
// skill only activates when `/caveman` is typed in a session, while AGENTS.md
// also reaches companion tasks and sessions resumed after a transfer. The
// rules go in the file itself: Codex does not expand Claude-style `@file`
// imports in AGENTS.md (a companion task reported an imported file as not
// loaded).

const fs = require('fs');
const path = require('path');
const os = require('os');
const plugins = require('./jev-plugins');

const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const agentsPath = path.join(codexHome, 'AGENTS.md');
// Marks the caveman block inside the generated AGENTS.md.
const BLOCK_START = '<!-- jev-caveman:start -->';
const BLOCK_END = '<!-- jev-caveman:end -->';
// SKILL.md sections kept for Codex. Intensity levels and their examples only
// matter with the /caveman command, which Codex does not have, and this text
// loads into every Codex session.
const KEPT_SECTIONS = ['Persistence', 'Rules', 'Auto-Clarity', 'Boundaries'];

const PLUGIN_ID = 'caveman@caveman';
const MARKETPLACE_SOURCE = 'JuliusBrussee/caveman';

// Caveman's own compact rule set (its .codex/hooks.json session-start text),
// used when the Claude plugin's full SKILL.md is not available to copy.
const FALLBACK_RULES = 'CAVEMAN MODE ACTIVE. Rules: Drop articles/filler/pleasantries/hedging. ' +
  'Fragments OK. Short synonyms. Pattern: [thing] [action] [reason]. [next step]. ' +
  'Not: Sure! I would be happy to help you with that. Yes: Bug in auth middleware. Fix: ' +
  'Code/commits/security: write normal. User says stop caveman or normal mode to deactivate.';

const pluginInstall = () => plugins.claudeInstall(PLUGIN_ID);

// 'active' | 'disabled' | 'missing'
const claudeStatus = () => plugins.claudePluginStatus(PLUGIN_ID);

function readAgents() {
  try {
    return fs.readFileSync(agentsPath, 'utf8');
  } catch (e) {
    return '';
  }
}

// 'active' | 'missing' | 'no-codex'
function codexStatus() {
  if (!fs.existsSync(codexHome)) return 'no-codex';
  const text = readAgents();
  const start = text.indexOf(BLOCK_START);
  return start !== -1 && text.indexOf(BLOCK_END, start) !== -1 ? 'active' : 'missing';
}

// Install or enable the caveman plugin. Returns a line describing what was
// done. Open sessions pick the change up after /reload-plugins.
const installClaude = () => plugins.ensureClaudePlugin(PLUGIN_ID, MARKETPLACE_SOURCE);

// Caveman's rules for Codex: selected sections of the Claude plugin's
// SKILL.md when present, so both sides follow the same (and updated) rules,
// else the fallback.
function codexRules() {
  const install = pluginInstall();
  if (install && install.installPath) {
    try {
      const skill = fs.readFileSync(path.join(install.installPath, 'skills', 'caveman', 'SKILL.md'), 'utf8');
      const body = skill.replace(/^---\n[\s\S]*?\n---\n/, '');
      // Intro line(s) before the first heading, then the kept sections.
      const [intro, ...sections] = body.split(/^## /m);
      const kept = sections.filter((s) => KEPT_SECTIONS.includes(s.split('\n')[0].trim()));
      if (kept.length > 0) {
        return {
          source: `caveman plugin ${install.version || ''}`.trim(),
          text: [intro.trim(), ...kept.map((s) => `### ${s.trim()}`)].join('\n\n'),
        };
      }
    } catch (e) {
      // Fall through to the built-in rules.
    }
  }
  return { source: 'built-in fallback', text: FALLBACK_RULES };
}

// The managed caveman block for Codex's AGENTS.md. jev-sync.js places it
// when it generates AGENTS.md.
function codexBlock() {
  const rules = codexRules();
  return [
    BLOCK_START,
    `## Caveman mode (always on, from the ${rules.source})`,
    '',
    'Applies to your replies and final summaries. Code, commands, commit messages, and file contents stay normal.',
    '',
    rules.text,
    BLOCK_END,
  ].join('\n');
}

module.exports = { claudeStatus, codexStatus, installClaude, codexBlock };
