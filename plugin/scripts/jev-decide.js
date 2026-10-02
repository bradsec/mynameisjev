// jev-decide — backs /mynameisjev:decide: asks Jev to pick one of a few
// options. Input is either the user's raw arguments ("a | b -- criteria") or
// options Claude took from the conversation, with optional context. Jev
// returns a pick and a probability per option, never a reason; the command
// has Claude add its own, labelled as such.

const { askJev } = require('./jev-api');
const { redact } = require('./jev-redact');

const MAX_OPTIONS = 8;
const MAX_OPTION_CHARS = 200;
const MAX_QUESTION_CHARS = 1000;
const MAX_CONTEXT_CHARS = 16000;
const TIMEOUT_MS = 15000;
// Below this gap between the top two probabilities the pick is a toss-up.
const TOSS_UP_GAP = 0.15;
const USAGE = 'usage: /mynameisjev:decide option A | option B [| ...] [-- criteria]';

// "a | b -- criteria": options split on "|", criteria after the first " -- "
// (or a trailing "--"), so option names like "--force" survive.
function parseRaw(raw) {
  const text = String(raw);
  const m = text.match(/^(.*?)(?:\s--(?:\s+(.*))?)?$/s);
  const options = m[1].split('|').map((s) => s.trim()).filter(Boolean);
  return { options, criteria: (m[2] || '').trim() };
}

function checkText(value, label, max) {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string') throw new Error(`${label} must be text`);
  if (value.length > max) throw new Error(`${label} is longer than ${max} characters`);
  return value.trim();
}

// Validates the input and builds the Jev request. Returns the options too,
// so the answer's o1..oN keys can be mapped back to their text.
function buildRequest(input) {
  if (!input || typeof input !== 'object') throw new Error(USAGE);
  let { options, criteria } = typeof input.raw === 'string' ? parseRaw(input.raw) : input;
  if (!Array.isArray(options)) throw new Error(USAGE);
  if (options.length < 2) throw new Error(`need at least 2 options. ${USAGE}`);
  if (options.length > MAX_OPTIONS) throw new Error(`at most ${MAX_OPTIONS} options`);
  options = options.map((o, i) => {
    if (typeof o !== 'string' || !o.trim()) throw new Error(`option ${i + 1} must be non-empty text`);
    if (o.length > MAX_OPTION_CHARS) throw new Error(`option ${i + 1} is longer than ${MAX_OPTION_CHARS} characters`);
    return o.trim();
  });
  if (new Set(options.map((o) => o.toLowerCase())).size !== options.length) throw new Error('options must differ');
  const question = checkText(input.question, 'question', MAX_QUESTION_CHARS);
  criteria = checkText(criteria, 'criteria', MAX_QUESTION_CHARS);
  const context = checkText(input.context, 'context', MAX_CONTEXT_CHARS);

  const instructions = [
    question || 'Which option is the better choice?',
    criteria ? `Judge by: ${criteria}.` : '',
  ].filter(Boolean).join(' ');
  const questions = {
    pick: {
      type: 'choice',
      instructions: redact(instructions),
      criteria: Object.fromEntries(options.map((o, i) => [`o${i + 1}`, redact(o)])),
    },
  };
  const state = { task: 'Pick the best option for the question.' };
  if (context) state.context = redact(context);
  return { state, questions, options };
}

function formatResult(options, answer, cost) {
  if (!answer) throw new Error('Jev returned no answer');
  const index = (key) => Number(String(key).slice(1)) - 1;
  if (!/^o\d+$/.test(String(answer.choice)) || !options[index(answer.choice)]) {
    throw new Error(`Jev returned an unexpected choice (${answer.choice})`);
  }
  const probs = answer.probabilities || {};
  const rows = options
    .map((text, i) => ({ text, key: `o${i + 1}`, p: Number(probs[`o${i + 1}`]) || 0 }))
    .sort((a, b) => (a.key === answer.choice ? -1 : b.key === answer.choice ? 1 : b.p - a.p));
  const width = Math.max(...rows.map((r) => r.text.length));
  const lines = rows.map((r, i) => `${i === 0 ? 'Pick: ' : '      '}${r.text.padEnd(width)}  ${r.p.toFixed(2)}`);
  if (rows.length > 1 && rows[0].p - rows[1].p < TOSS_UP_GAP) {
    lines.push(`Toss-up: the top two are within ${TOSS_UP_GAP}; either is defensible.`);
  }
  lines.push(`Cost: $${Number(cost || 0).toFixed(5)}`);
  return lines;
}

async function decide(input, apiKey, ask = askJev) {
  const { state, questions, options } = buildRequest(input);
  if (!apiKey) throw new Error('OPENROUTER_API_KEY is not set; see the README install steps');
  let data;
  try {
    data = await ask(state, questions, { apiKey, timeoutMs: TIMEOUT_MS });
  } catch (e) {
    if (e.name === 'AbortError') throw new Error(`Jev did not answer within ${TIMEOUT_MS / 1000}s`);
    throw e;
  }
  return formatResult(options, data && data.answers && data.answers.pick, data && data.usage && data.usage.cost);
}

module.exports = { parseRaw, buildRequest, formatResult, decide, TOSS_UP_GAP };
