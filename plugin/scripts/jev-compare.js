// jev-compare — backs /mynameisjev:compare: Jev scores 2 to 4 code variants
// on a few criteria and picks the best overall. Variants are files (or line
// ranges) the user names, read here, or snippets Claude takes from the
// conversation. Jev only judges the text it is sent; it runs nothing.

const fs = require('fs');
const path = require('path');
const { askJev } = require('./jev-api');
const { redact } = require('./jev-redact');
const { TOSS_UP_GAP } = require('./jev-decide');

const MIN_VARIANTS = 2;
const MAX_VARIANTS = 4;
const MAX_CRITERIA = 4;
const MAX_CRITERION_CHARS = 100;
const MAX_LABEL_CHARS = 80;
// Four variants of this size stay well inside Jev's 32k-token context.
const MAX_VARIANT_CHARS = 6000;
const MAX_CONTEXT_CHARS = 4000;
const TIMEOUT_MS = 20000;
const DEFAULT_CRITERIA = ['correctness risk', 'readability', 'simplicity'];
const LEVELS = ['very poor', 'poor', 'fair', 'good', 'very good'];
const USAGE = 'usage: /mynameisjev:compare <file>[:start-end] <file>[:start-end] [...] [-- criterion, criterion]';

// "a.js b.js:5-30 -- readability, risk"
function parseRaw(raw) {
  const text = String(raw).trim();
  const at = text.search(/(^|\s)--(\s|$)/);
  const head = at < 0 ? text : text.slice(0, at);
  const tail = at < 0 ? '' : text.slice(at).replace(/^\s*--/, '');
  const files = head.split(/\s+/).filter(Boolean).map((token) => {
    const m = token.match(/^(.+):(\d+)-(\d+)$/);
    return m ? { file: m[1], start: Number(m[2]), end: Number(m[3]) } : { file: token, start: null, end: null };
  });
  const criteria = tail.split(',').map((c) => c.trim()).filter(Boolean);
  return { files, criteria };
}

// Reads each file or range. Paths resolve against cwd and, after following
// symlinks, must stay inside root: their contents are sent to OpenRouter.
function readVariants(files, { root, cwd }) {
  const rootReal = fs.realpathSync(root);
  const variants = files.map(({ file, start, end }) => {
    let real;
    try {
      real = fs.realpathSync(path.resolve(cwd, file));
    } catch (e) {
      throw new Error(`cannot read ${file} (${e.code || e.message})`);
    }
    const rel = path.relative(rootReal, real);
    if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`${file} is outside the project (${rootReal}); only project files are sent to Jev`);
    let text;
    try {
      text = fs.readFileSync(real, 'utf8');
    } catch (e) {
      throw new Error(`cannot read ${file} (${e.code || e.message})`);
    }
    if (start !== null) {
      if (start < 1 || end < start) throw new Error(`${file}:${start}-${end} is not a valid line range`);
      const all = text.split('\n');
      if (end > all.length) throw new Error(`${file}:${start}-${end} goes past the end (the file has ${all.length} lines)`);
      text = all.slice(start - 1, end).join('\n');
    }
    if (text.length > MAX_VARIANT_CHARS) {
      throw new Error(`${file} is over ${MAX_VARIANT_CHARS} characters; compare a line range instead, like ${file}:1-80`);
    }
    return { file, range: start !== null ? `:${start}-${end}` : '', text };
  });
  // Short labels, unless two files share a name.
  const names = variants.map((v) => path.basename(v.file));
  return variants.map((v, i) => ({
    label: `${names.filter((n) => n === names[i]).length > 1 ? v.file.replace(/\\/g, '/') : names[i]}${v.range}`,
    text: v.text,
  }));
}

function buildRequest(input) {
  const variants = input && input.variants;
  if (!Array.isArray(variants)) throw new Error(USAGE);
  if (variants.length < MIN_VARIANTS || variants.length > MAX_VARIANTS) throw new Error(`need ${MIN_VARIANTS} to ${MAX_VARIANTS} variants. ${USAGE}`);
  variants.forEach((v, i) => {
    if (!v || typeof v.label !== 'string' || !v.label.trim() || v.label.length > MAX_LABEL_CHARS) throw new Error(`variant ${i + 1} needs a label of at most ${MAX_LABEL_CHARS} characters`);
    if (typeof v.text !== 'string' || !v.text.trim()) throw new Error(`variant ${i + 1} (${v.label}) is empty`);
    if (v.text.length > MAX_VARIANT_CHARS) throw new Error(`variant ${i + 1} (${v.label}) is over ${MAX_VARIANT_CHARS} characters`);
  });
  let criteria = input.criteria;
  if (typeof criteria === 'string') criteria = criteria.split(',');
  criteria = (Array.isArray(criteria) ? criteria : []).map((c) => String(c).trim()).filter(Boolean);
  if (criteria.length === 0) criteria = DEFAULT_CRITERIA;
  if (criteria.length > MAX_CRITERIA) throw new Error(`at most ${MAX_CRITERIA} criteria`);
  if (criteria.some((c) => c.length > MAX_CRITERION_CHARS)) throw new Error(`each criterion must be at most ${MAX_CRITERION_CHARS} characters`);
  const context = input.context === undefined || input.context === null ? '' : String(input.context).trim();
  if (context.length > MAX_CONTEXT_CHARS) throw new Error(`context is longer than ${MAX_CONTEXT_CHARS} characters`);

  const labels = variants.map((v) => v.label.trim());
  const questions = {};
  labels.forEach((label, vi) => {
    criteria.forEach((criterion, ci) => {
      questions[`v${vi + 1}_c${ci + 1}`] = {
        type: 'score',
        instructions: redact(`Rate variant "${label}" on ${criterion}, compared with the other variants. Higher is better: for a criterion like risk, less risk scores higher.`),
        criteria: LEVELS,
      };
    });
  });
  questions.best = {
    type: 'choice',
    instructions: redact(`Which variant is best overall, judged by: ${criteria.join(', ')}?`),
    criteria: Object.fromEntries(labels.map((l, i) => [`v${i + 1}`, redact(l)])),
  };
  const state = {
    task: 'Compare these code variants.',
    variants: variants.map((v, i) => ({ label: redact(labels[i]), text: redact(v.text) })),
  };
  if (context) state.context = redact(context);
  return { state, questions, labels, criteria };
}

function formatResult(labels, criteria, answers, cost) {
  const best = answers && answers.best;
  if (!best) throw new Error('Jev returned no answer');
  const index = Number(String(best.choice).slice(1)) - 1;
  if (!/^v\d+$/.test(String(best.choice)) || !labels[index]) throw new Error(`Jev returned an unexpected choice (${best.choice})`);

  const nameWidth = Math.max(...criteria.map((c) => c.length));
  const colWidth = labels.map((l) => Math.max(l.length, 3));
  const row = (name, cells) => `${name.padEnd(nameWidth)}  ${cells.map((c, i) => c.padStart(colWidth[i])).join('  ')}`;
  const lines = [row('', labels)];
  criteria.forEach((criterion, ci) => {
    lines.push(row(criterion, labels.map((_, vi) => {
      const s = answers[`v${vi + 1}_c${ci + 1}`] && answers[`v${vi + 1}_c${ci + 1}`].score;
      return Number.isFinite(s) ? s.toFixed(1) : '-';
    })));
  });
  const probs = best.probabilities || {};
  const ranked = labels
    .map((label, i) => ({ label, key: `v${i + 1}`, p: Number(probs[`v${i + 1}`]) || 0 }))
    .sort((a, b) => (a.key === best.choice ? -1 : b.key === best.choice ? 1 : b.p - a.p));
  lines.push(`Best: ${ranked.map((r) => `${r.label} ${r.p.toFixed(2)}`).join(', ')}`);
  if (ranked[0].p - ranked[1].p < TOSS_UP_GAP) lines.push(`Toss-up: the top two are within ${TOSS_UP_GAP}; either is defensible.`);
  lines.push(`Scores: 0 = ${LEVELS[0]}, 4 = ${LEVELS[LEVELS.length - 1]}`);
  lines.push(`Cost: $${Number(cost || 0).toFixed(5)}`);
  return lines.map((l) => l.trimEnd());
}

async function compare(input, apiKey, { root, cwd, ask = askJev }) {
  let request = input;
  if (input && typeof input.raw === 'string') {
    const { files, criteria } = parseRaw(input.raw);
    if (files.length < MIN_VARIANTS || files.length > MAX_VARIANTS) throw new Error(`need ${MIN_VARIANTS} to ${MAX_VARIANTS} files. ${USAGE}`);
    request = { variants: readVariants(files, { root, cwd }), criteria };
  }
  const { state, questions, labels, criteria } = buildRequest(request);
  if (!apiKey) throw new Error('OPENROUTER_API_KEY is not set; see the README install steps');
  let data;
  try {
    data = await ask(state, questions, { apiKey, timeoutMs: TIMEOUT_MS });
  } catch (e) {
    if (e.name === 'AbortError') throw new Error(`Jev did not answer within ${TIMEOUT_MS / 1000}s`);
    throw e;
  }
  return formatResult(labels, criteria, data && data.answers, data && data.usage && data.usage.cost);
}

module.exports = { parseRaw, readVariants, buildRequest, formatResult, compare, DEFAULT_CRITERIA, MAX_VARIANT_CHARS };
