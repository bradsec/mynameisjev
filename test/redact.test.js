const test = require('node:test');
const assert = require('node:assert');
const { redact, MARK } = require('../plugin/scripts/jev-redact');

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
  assert.strictEqual(redact('clone https://me:s3cret@example.com/repo.git'), `clone https://${MARK}@example.com/repo.git`);
});

test('leaves ordinary text alone', () => {
  const plain = [
    'Fix the token refresh bug in auth.js and add a test.',
    'Why does the password reset email not send?',
    'Rename getApiKey to readApiKey across the repo.',
    'Visit https://example.com/docs for details.',
    'Write a short email to my landlord about the faucet.',
  ];
  for (const p of plain) assert.strictEqual(redact(p), p);
});

test('passes through non-strings and empty text', () => {
  assert.strictEqual(redact(''), '');
  assert.strictEqual(redact(null), null);
});
