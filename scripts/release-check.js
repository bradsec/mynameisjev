#!/usr/bin/env node
// Release checks shared by CI and the release workflow.
//
//   node scripts/release-check.js            check plugin.json and CHANGELOG agree
//   node scripts/release-check.js v1.2.3     also check a release tag matches
//   node scripts/release-check.js --notes    print the current version's
//                                            CHANGELOG section (release notes)

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const fail = (msg) => {
  console.error(`release-check: ${msg}`);
  process.exit(1);
};

const plugin = JSON.parse(read('plugin/.claude-plugin/plugin.json'));
const marketplace = JSON.parse(read('.claude-plugin/marketplace.json'));
const version = plugin.version;
if (!/^\d+\.\d+\.\d+$/.test(version || '')) fail(`plugin.json version "${version}" is not MAJOR.MINOR.PATCH`);
if (!marketplace.plugins.some((p) => p.name === plugin.name)) fail(`marketplace.json has no entry for "${plugin.name}"`);

// The section for this version: from its "## x.y.z" heading to the next "## ".
const changelog = read('CHANGELOG.md');
const match = changelog.match(new RegExp(`^## ${version.replace(/\./g, '\\.')}\\s*\\n([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, 'm'));
if (!match) fail(`CHANGELOG.md has no "## ${version}" section`);

const arg = process.argv[2];
if (arg === '--notes') {
  process.stdout.write(`${match[1].trim()}\n`);
} else if (arg) {
  if (arg !== `v${version}`) fail(`tag ${arg} does not match plugin.json version ${version}`);
  console.log(`release-check: ${arg} matches plugin.json and CHANGELOG`);
} else {
  console.log(`release-check: version ${version} ok`);
}
