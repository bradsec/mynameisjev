const test = require('node:test');
const assert = require('node:assert');
const { redact, sanitize, MARK } = require('../plugin/scripts/jev-redact');

// Built by concatenation so the test file holds no string that secret
// scanners would flag as a real credential.
const fake = (prefix, n, ch = 'a') => prefix + ch.repeat(n);

test('redacts common key formats', () => {
  const keys = [
    fake('sk-or-v1-', 40),
    fake('sk-ant-api03-', 40),
    fake('sk-', 32),
    fake('ghp_', 36),
    fake('github_pat_', 40),
    fake('npm_', 36),
    fake('AKIA', 16, 'A'),
    fake('xoxb-', 30, '1'),
    fake('AIza', 35),
    fake('sk_live_', 24),
    `${fake('eyJ', 20)}.${fake('eyJ', 20)}.${fake('', 20, 'x')}`,
  ];
  for (const key of keys) {
    const out = redact(`please use ${key} for the call`);
    assert.strictEqual(out, `please use ${MARK} for the call`, key);
  }
});

test('redacts private key blocks, including unterminated ones', () => {
  const block = ['-----BEGIN', 'RSA PRIVATE KEY-----\nMIIEow\nabc\n-----END', 'RSA PRIVATE KEY-----'].join(' ');
  assert.strictEqual(redact(`key:\n${block}\ndone`), `key:\n${MARK}\ndone`);
  const cut = ['-----BEGIN', 'OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXk'].join(' ');
  assert.strictEqual(redact(`here ${cut}`), `here ${MARK}`);
});

test('keeps names but drops values of secret-looking assignments', () => {
  assert.strictEqual(redact('export OPENROUTER_API_KEY=abc123'), `export OPENROUTER_API_KEY=${MARK}`);
  assert.strictEqual(redact('DB_PASSWORD: "hunter2 x"'), `DB_PASSWORD: ${MARK}`);
  assert.strictEqual(redact('{"client_secret": "zzz", "id": 4}'), `{"client_secret": ${MARK}, "id": 4}`);
  assert.strictEqual(redact('token=xyz; next'), `token=${MARK}; next`);
});

test('redacts bearer tokens and URL credentials', () => {
  assert.strictEqual(redact(`Authorization: Bearer ${fake('', 30, 'b')}`), `Authorization: Bearer ${MARK}`);
  assert.strictEqual(redact('Authorization: Basic dXNlcjpwYXNz'), `Authorization: Basic ${MARK}`);
  assert.strictEqual(redact('authorization: basic dTpw'), `authorization: basic ${MARK}`);
  assert.strictEqual(redact('clone https://me:s3cret@example.com/repo.git'), `clone https://${MARK}@example.com/repo.git`);
  assert.strictEqual(redact('clone https://mytoken@example.com/repo.git'), `clone https://${MARK}@example.com/repo.git`);
});

test('leaves ordinary text alone', () => {
  const plain = [
    'Fix the token refresh bug in auth.js and add a test.',
    'Why does the password reset email not send?',
    'Rename getApiKey to readApiKey across the repo.',
    'Visit https://example.com/docs for details.',
    'Write a short email to my landlord about the faucet.',
    'Email me@example.com and clone git@github.com:org/repo.git.',
  ];
  for (const p of plain) assert.strictEqual(redact(p), p);
});

test('passes through non-strings and empty text', () => {
  assert.strictEqual(redact(''), '');
  assert.strictEqual(redact(null), null);
});

test('sanitize replaces fenced code with line count and language', () => {
  assert.strictEqual(sanitize('Fix this:\n```js\nconst secret = 1;\nrun();\n```\nThanks.'),
    'Fix this:\n[code block: 2 lines, js]\nThanks.');
  assert.strictEqual(sanitize('~~~\none line\n~~~'), '[code block: 1 lines]');
});

test('sanitize collapses long pasted runs after three lines', () => {
  const lines = Array.from({ length: 9 }, (_, i) => `line ${i + 1}`);
  assert.strictEqual(sanitize(`Review:\n${lines.join('\n')}\n\nThen advise.`),
    'Review:\nline 1\nline 2\n[7 more lines]\n\nThen advise.');
});

test('sanitize replaces identifying text and keeps prose and versions', () => {
  const out = sanitize('Please contact me@example.com, check https://example.com/private?q=1, 192.0.2.4, 2001:db8::1, +1 (415) 555-0134, /home/alice/project/file.js, ~/notes/todo.txt, and C:\\Users\\alice\\work\\app.js. Version 2.1.330 and count 123456789 remain.');
  for (const value of ['[email]', '[url: example.com]', '[ip]', '[phone]', 'file.js', 'todo.txt', 'app.js', '2.1.330', '123456789']) assert.ok(out.includes(value), value);
  for (const value of ['me@example.com', '/private', '192.0.2.4', '2001:db8::1', '555-0134', '/home/alice', 'C:\\Users']) assert.ok(!out.includes(value), value);
});

test('sanitize redacts secrets and caps output at 1000 characters', () => {
  assert.strictEqual(sanitize(`Use ${fake('sk-or-v1-', 40)}`), `Use ${MARK}`);
  assert.strictEqual(sanitize('a'.repeat(1200)).length, 1000);
});

test('sanitize keeps ISO dates but masks phone numbers', () => {
  assert.strictEqual(sanitize('Due 2026-11-23, call +61 412 345 678'), 'Due 2026-11-23, call [phone]');
});
