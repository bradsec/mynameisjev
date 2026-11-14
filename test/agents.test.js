const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const frontmatter = (name) => {
  const text = fs.readFileSync(path.join(__dirname, '..', 'plugin', 'agents', `${name}.md`), 'utf8');
  return text.split('---')[1];
};

test('cheaper helpers stop at a turn cap instead of running on', () => {
  assert.match(frontmatter('tiny'), /^maxTurns: 25$/m);
  assert.match(frontmatter('everyday'), /^maxTurns: 40$/m);
});
