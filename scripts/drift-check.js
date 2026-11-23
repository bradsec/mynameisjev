#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const baselinePath = path.join(__dirname, 'drift-baseline.json');
const headers = { 'User-Agent': 'mynameisjev-drift-check' };

function filterModelIds(ids) {
  return ids.filter((id) => /^(anthropic\/|openai\/gpt-|google\/gemini-|typesafe\/)/.test(id) && !id.endsWith(':batch')).sort();
}

function newModelIds(current, baseline) {
  const known = new Set(baseline);
  return current.filter((id) => !known.has(id));
}

function parseJevModel(source) {
  const match = source.match(/^const MODEL = ['"](typesafe\/[^'"]+)['"];?$/m);
  if (!match) throw new Error('cannot find pinned Jev model in jev-api.js');
  return match[1];
}

function parseCodexModels(source) {
  const tiers = source.match(/const DEFAULT_TIERS = \{([\s\S]*?)^\};/m);
  const premium = source.match(/const PREMIUM_MODELS = new Set\(\[([\s\S]*?)\]\);/);
  if (!tiers || !premium) throw new Error('cannot find pinned Codex models in jev-codex.js');
  const ids = [...tiers[1].matchAll(/\bmodel: ['"]([^'"]+)['"]/g), ...premium[1].matchAll(/['"](gpt-[^'"]+)['"]/g)]
    .map((match) => match[1]);
  if (!ids.length) throw new Error('no pinned Codex models found in jev-codex.js');
  return [...new Set(ids)].sort();
}

function parseClaudeChangelog(markdown) {
  const releases = [];
  let release;
  for (const line of markdown.split(/\r?\n/)) {
    const heading = line.match(/^## (\d+\.\d+\.\d+)\b/);
    if (heading) {
      release = { version: heading[1], bullets: [] };
      releases.push(release);
    } else if (/^## /.test(line)) {
      release = undefined;
    } else if (release && /^\s*- /.test(line)) {
      release.bullets.push(line.replace(/^\s*- /, ''));
    }
  }
  if (!releases.length) throw new Error('Claude Code changelog has no version headings');
  return releases;
}

function compareVersions(a, b) {
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (left[i] !== right[i]) return left[i] - right[i];
  }
  return 0;
}

function relevantClaudeChanges(releases, baseline) {
  let remaining = 40;
  return releases.filter((release) => compareVersions(release.version, baseline) > 0)
    .sort((a, b) => compareVersions(b.version, a.version))
    .map((release) => {
      const bullets = release.bullets.filter((bullet) => /plugin|hook|agent|subagent|effort|model|frontmatter|statusline|skill/i.test(bullet)).slice(0, remaining);
      remaining -= bullets.length;
      return { version: release.version, bullets };
    });
}

function renderReport({ newModels, jevMissing, jevModel, missingPinned, claudeChanges, codexChanged, codexTag, baseline }) {
  const drift = newModels.length || jevMissing || missingPinned.length || claudeChanges.length || codexChanged;
  const lines = ['# Model or tooling drift check', ''];
  if (!drift) return `${lines.join('\n')}No drift detected.\n`;
  if (newModels.length) lines.push('## New models', '', ...newModels.map((id) => `- \`${id}\``), '');
  if (jevMissing) lines.push('## Pinned Jev model unavailable', '', `- \`${jevModel}\` endpoint returned HTTP 404.`, '');
  if (missingPinned.length) lines.push('## Pinned Codex models not listed', '', ...missingPinned.map((id) => `- \`${id}\``), '');
  if (claudeChanges.length) {
    lines.push('## Claude Code releases', '', `Newer than \`${baseline.claudeCode}\`: ${claudeChanges.map((release) => `\`${release.version}\``).join(', ')}`, '');
    for (const release of claudeChanges) {
      if (release.bullets.length) lines.push(`### ${release.version}`, '', ...release.bullets.map((bullet) => `- ${bullet}`), '');
    }
  }
  if (codexChanged) lines.push('## Codex release', '', `- Latest: \`${codexTag}\`; baseline: \`${baseline.codex || '(none)'}\`.`, '');
  return `${lines.join('\n').trimEnd()}\n`;
}

async function get(url) {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response;
}

async function collect() {
  const jevModel = parseJevModel(fs.readFileSync(path.join(root, 'plugin/scripts/jev-api.js'), 'utf8'));
  const codexModels = parseCodexModels(fs.readFileSync(path.join(root, 'plugin/scripts/jev-codex.js'), 'utf8'));
  const modelsUrl = 'https://openrouter.ai/api/v1/models';
  const jevUrl = `${modelsUrl}/${jevModel}/endpoints`;
  const claudeUrl = 'https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md';
  const codexUrl = 'https://api.github.com/repos/openai/codex/releases/latest';
  const [modelsResponse, jevResponse, claudeResponse, codexResponse] = await Promise.all([
    get(modelsUrl), fetch(jevUrl, { headers, signal: AbortSignal.timeout(15000) }), get(claudeUrl), get(codexUrl),
  ]);
  if (jevResponse.status !== 200 && jevResponse.status !== 404) throw new Error(`${jevUrl}: HTTP ${jevResponse.status}`);
  const models = await modelsResponse.json();
  const codex = await codexResponse.json();
  if (!Array.isArray(models.data) || typeof codex.tag_name !== 'string') throw new Error('invalid vendor response');
  return {
    openrouterModels: filterModelIds(models.data.map((model) => model.id)),
    jevModel,
    jevMissing: jevResponse.status === 404,
    codexModels,
    claudeReleases: parseClaudeChangelog(await claudeResponse.text()),
    codexTag: codex.tag_name,
  };
}

async function main(args) {
  if (args.length === 1 && args[0] === '--help') {
    console.log('Usage: node scripts/drift-check.js [--out FILE | --update-baseline]');
    return;
  }
  const update = args.length === 1 && args[0] === '--update-baseline';
  const out = args.length === 2 && args[0] === '--out' && args[1];
  if (args.length && !update && !out) throw new Error('usage: node scripts/drift-check.js [--out FILE | --update-baseline]');
  const current = await collect();
  if (update) {
    if (current.jevMissing) throw new Error(`pinned Jev model unavailable: ${current.jevModel}`);
    const baseline = {
      openrouterModels: current.openrouterModels,
      claudeCode: current.claudeReleases.reduce((latest, release) => compareVersions(release.version, latest) > 0 ? release.version : latest, '0.0.0'),
      codex: current.codexTag,
    };
    fs.writeFileSync(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`);
    console.log(`Updated baseline: ${baseline.openrouterModels.length} models, Claude Code ${baseline.claudeCode}, Codex ${baseline.codex}`);
    return;
  }
  const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
  const report = {
    newModels: newModelIds(current.openrouterModels, baseline.openrouterModels),
    jevMissing: current.jevMissing,
    jevModel: current.jevModel,
    missingPinned: current.codexModels.map((id) => `openai/${id}`).filter((id) => !current.openrouterModels.includes(id)),
    claudeChanges: relevantClaudeChanges(current.claudeReleases, baseline.claudeCode),
    codexChanged: current.codexTag !== baseline.codex,
    codexTag: current.codexTag,
    baseline,
  };
  const drift = Boolean(report.newModels.length || report.jevMissing || report.missingPinned.length || report.claudeChanges.length || report.codexChanged);
  const markdown = renderReport(report);
  process.stdout.write(markdown);
  if (out) fs.writeFileSync(out, markdown);
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `drift=${drift}\n`);
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`drift-check: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  filterModelIds, newModelIds, parseClaudeChangelog, compareVersions,
  relevantClaudeChanges, parseJevModel, parseCodexModels, renderReport,
};
