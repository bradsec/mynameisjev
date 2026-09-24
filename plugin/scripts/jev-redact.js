// jev-redact — strips likely secrets from message text before it leaves the
// machine (the Jev call to OpenRouter) or is stored (state.lastPrompt).
// Sizing only needs the shape of a request, so a key pasted into a prompt
// is replaced with a marker rather than sent. Pattern-based: it catches
// common key formats and `name = value` assignments whose name says secret,
// not every possible credential.

const MARK = '[REDACTED]';

const PATTERNS = [
  // PEM private key blocks, whole.
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g,
  // OpenAI, OpenRouter (sk-or-...), Anthropic (sk-ant-...) and similar.
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  // GitHub tokens.
  /\bgh[pousr]_[A-Za-z0-9]{30,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
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

// `Authorization: Bearer <token>`: keep the scheme, drop the token.
const BEARER = /\b(Bearer\s+)[A-Za-z0-9._~+/-]{16,}=*/g;
// user:password@ in URLs.
const URL_CREDENTIALS = /(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi;
// API_KEY=..., "password": "...", client_secret: ... : keep the name, drop the value.
const ASSIGNMENT = /\b([A-Za-z0-9_.-]*(?:secret|token|passwd|password|api[_-]?key|access[_-]?key|private[_-]?key|credentials?)[A-Za-z0-9_.-]*["']?\s*[:=]\s*)("[^"\n]*"|'[^'\n]*'|[^\s,;}]+)/gi;

function redact(text) {
  if (typeof text !== 'string' || text === '') return text;
  let out = text;
  for (const re of PATTERNS) out = out.replace(re, MARK);
  out = out.replace(BEARER, `$1${MARK}`);
  out = out.replace(URL_CREDENTIALS, `$1${MARK}@`);
  // A value already replaced above stays as the marker.
  out = out.replace(ASSIGNMENT, (m, name, value) => (value === MARK ? m : `${name}${MARK}`));
  return out;
}

module.exports = { redact, MARK };
