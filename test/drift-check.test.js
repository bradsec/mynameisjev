const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  filterModelIds, newModelIds, parseClaudeChangelog, compareVersions,
  relevantClaudeChanges, parseJevModel, parseCodexModels, renderReport,
} = require('../scripts/drift-check');

test('keeps vendor models and excludes batch variants', () => {
  assert.deepEqual(filterModelIds([
    'openai/gpt-6:batch', 'anthropic/claude-x', 'typesafe/jev-router',
    'google/gemini', 'openai/o1', 'openai/gpt-6',
  ]), ['anthropic/claude-x', 'openai/gpt-6', 'typesafe/jev-router']);
});

test('reports only new model ids', () => {
  assert.deepEqual(newModelIds(['openai/gpt-6', 'openai/gpt-7'], ['openai/gpt-6']), ['openai/gpt-7']);
});

test('parses changelog releases and compares numeric version parts', () => {
  const releases = parseClaudeChangelog('## 2.1.330\n- Plugin hooks changed\n\n## 2.1.99\n- Fixed UI\n');
  assert.deepEqual(releases, [
    { version: '2.1.330', bullets: ['Plugin hooks changed'] },
    { version: '2.1.99', bullets: ['Fixed UI'] },
  ]);
  assert.ok(compareVersions('2.1.330', '2.1.99') > 0);
  assert.ok(compareVersions('2.1.99', '2.1.330') < 0);
});

test('selects relevant bullets in new releases and caps the total', () => {
  const releases = [
    { version: '2.1.330', bullets: ['Fixed UI', ...Array.from({ length: 45 }, (_, i) => `Plugin change ${i}`)] },
    { version: '2.1.99', bullets: ['Agent fix'] },
  ];
  const result = relevantClaudeChanges(releases, '2.1.99');
  assert.deepEqual(result.map((release) => release.version), ['2.1.330']);
  assert.equal(result[0].bullets.length, 40);
  assert.equal(result[0].bullets[0], 'Plugin change 0');
  assert.equal(result[0].bullets[39], 'Plugin change 39');
});

test('reads pinned models from plugin source', () => {
  const root = path.join(__dirname, '..', 'plugin', 'scripts');
  assert.equal(parseJevModel(fs.readFileSync(path.join(root, 'jev-api.js'), 'utf8')), 'typesafe/jev-1.14');
  assert.deepEqual(parseCodexModels(fs.readFileSync(path.join(root, 'jev-codex.js'), 'utf8')),
    ['gpt-6-luna', 'gpt-6.2-astra', 'gpt-6.2-sol']);
});

test('reports no drift when sources match baseline', () => {
  const report = renderReport({ newModels: [], jevMissing: false, missingPinned: [], claudeChanges: [], codexChanged: false });
  assert.match(report, /No drift detected/);
  assert.doesNotMatch(report, /## New models/);
});
