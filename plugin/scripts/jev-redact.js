// jev-redact — strips likely secrets from message text before it leaves the
// machine (the Jev call to OpenRouter) or is stored (state.lastPrompt).
// Sizing only needs the shape of a request, so a key pasted into a prompt
// is replaced with a marker rather than sent. Pattern-based: it catches
// common key formats and `name = value` assignments whose name says secret,
// not every possible credential.

const MARK = '[REDACTED]';
const { isIP } = require('node:net');

const PATTERNS = [
  // PEM private key blocks, whole.
  /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]{0,40}PRIVATE KEY-----|$)/g,
  // OpenAI, OpenRouter (sk-or-...), Anthropic (sk-ant-...) and similar.
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  // GitHub tokens.
  /\bgh[pousr]_[A-Za-z0-9]{30,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bnpm_[A-Za-z0-9]{36}\b/g,
  // AWS access key ids.
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  // Slack tokens.
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  // Google API keys.
  /\bAIza[0-9A-Za-z_-]{35}/g,
  // Stripe keys.
  /\b[rsp]k_(?:live|test)_[A-Za-z0-9]{16,}/g,
  // JSON Web Tokens.
  /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
];

// Authorization headers: keep the scheme, drop the credential.
const BEARER = /\b(Bearer\s+)[A-Za-z0-9._~+/-]{16,}=*/g;
const BASIC = /\b(Authorization:\s*Basic\s+)[A-Za-z0-9+/]{4,}={0,2}/gi;
// userinfo in URLs.
const URL_CREDENTIALS = /(\b[a-z][a-z0-9+.-]{0,30}:\/\/)[^\s/:@]+(?::[^\s/@]+)?@/gi;
// API_KEY=..., "password": "...", client_secret: ... : keep the name, drop the value.
const ASSIGNMENT = /\b([A-Za-z0-9_.-]{0,40}(?:secret|token|passwd|password|api[_-]?key|access[_-]?key|private[_-]?key|credentials?)[A-Za-z0-9_.-]{0,40}["']?\s*[:=]\s*)("[^"\n]*"|'[^'\n]*'|[^\s,;})\]'"`&]+)/gi;

function redact(text) {
  if (typeof text !== 'string' || text === '') return text;
  let out = text;
  for (const re of PATTERNS) out = out.replace(re, MARK);
  out = out.replace(BEARER, `$1${MARK}`);
  out = out.replace(BASIC, `$1${MARK}`);
  out = out.replace(URL_CREDENTIALS, `$1${MARK}@`);
  // A value already replaced above stays as the marker.
  out = out.replace(ASSIGNMENT, (m, name, value) => (value === MARK ? m : `${name}${MARK}`));
  return out;
}

function sanitize(text) {
  if (typeof text !== 'string' || text === '') return text;
  const fenced = [];
  const source = redact(text).split('\n');
  for (let i = 0; i < source.length;) {
    const open = source[i].match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (!open) { fenced.push(source[i++]); continue; }
    const close = new RegExp(`^ {0,3}${open[1][0]}{${open[1].length},}[ \\t]*$`);
    const start = ++i;
    while (i < source.length && !close.test(source[i])) i++;
    const count = i - start - (i === source.length && source[i - 1] === '' ? 1 : 0);
    const label = open[2].trim().split(/\s+/, 1)[0];
    fenced.push(`[code block: ${count} lines${/^[A-Za-z0-9_+.#-]{1,20}$/.test(label) ? `, ${label}` : ''}]`);
    if (i < source.length) i++;
  }
  let out = fenced.join('\n');
  // Collapse every run of eight or more non-empty lines, keeping its first three.
  const lines = out.split('\n');
  const compact = [];
  for (let i = 0; i < lines.length;) {
    let end = i;
    while (end < lines.length && lines[end].trim()) end++;
    if (end - i >= 8) compact.push(...lines.slice(i, i + 3), `[${end - i - 3} more lines]`);
    else compact.push(...lines.slice(i, end));
    if (end < lines.length) compact.push(lines[end]);
    i = end + 1;
  }
  out = compact.join('\n');
  // Bound masking work and drop a partial token so its unmasked prefix cannot reach output.
  if (out.length > 4000) out = out.slice(0, 4000).replace(/\S+$/, '');
  out = out.replace(/\bhttps?:\/\/[^\s<>()]+/gi, (url) => {
    try { return `[url: ${new URL(url).hostname}]`; } catch (_) { return '[url]'; }
  });
  out = out.replace(/\b[A-Z0-9._%+-]{1,64}@[A-Z0-9.-]{1,253}\.[A-Z]{2,63}\b/gi, '[email]');
  out = out.replace(/\b[0-9a-f:]{0,45}:[0-9a-f:]{1,45}\b/gi, (value) => isIP(value) === 6 ? '[ip]' : value);
  out = out.replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[ip]');
  out = out.replace(/\+?\d[\d ().-]{5,30}\d/g, (value) => {
    const digits = value.replace(/\D/g, '');
    // ISO dates (2026-11-23) carry no identity and help size the request.
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
    return digits.length >= 7 && /[ ()-]/.test(value) ? '[phone]' : value;
  });
  out = out.replace(/\bfile:\/\/\/(?:[^\s,;:()[\]{}<>\\/]+[\\/])*[^\s,;:()[\]{}<>\\/]+/gi,
    (full) => full.split(/[\\/]/).pop());
  out = out.replace(/(^|[\s(=:'"`])((?:~\/|\/|[A-Za-z]:\\)(?:[^\s,;:()[\]{}<>\\/]+[\\/])*[^\s,;:()[\]{}<>\\/]+)/gm,
    (_, before, full) => before + full.split(/[\\/]/).pop());
  return out.slice(0, 1000);
}

module.exports = { redact, sanitize, MARK };
