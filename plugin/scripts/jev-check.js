#!/usr/bin/env node
// jev-check — Stop hook for `/mynameisjev:check on`: asks Jev whether
// Claude's final reply covers every part of the user's request, and if a
// part looks missed, blocks the stop once so Claude finishes it or says why
// it was skipped.
//
// Jev answers typed questions but writes no text, so it cannot name what
// was missed. The request is split into parts (list items, else sentences)
// and Jev gets one yes/no question per part; the hook quotes the parts that
// score low. `stop_hook_active` is set on the stop that follows a block, so
// the check never blocks twice in a turn.

const st = require('./jev-state');
const { askJev } = require('./jev-api');
const { redact } = require('./jev-redact');
const { readTail, userText } = require('./jev-compact');

const MAX_PARTS = 8;
const PART_CHARS = 300;
const MIN_PART_CHARS = 12;
const REQUEST_CHARS = 8000;
const REPLY_CHARS = 24000;
const TIMEOUT_MS = 5000;
// A part below this is missed; asks_user at or above ASKS_USER means Claude
// is waiting on the user, so the turn counts as complete.
const COVERED = 0.3;
const ASKS_USER = 0.5;

const clip = (text, n) => (text.length > n ? `${text.slice(0, n - 3)}...` : text);
const LIST_ITEM = /^\s*(?:[-*•]|\d+[.)])\s+(.*)$/;

// The request's parts in order: each list item, and each sentence of the
// text around them. Code blocks are left out; they are material, not asks.
function splitParts(text) {
  const parts = [];
  let prose = [];
  const flush = () => {
    const joined = prose.join(' ').replace(/\s+/g, ' ').trim();
    if (joined) parts.push(...joined.split(/(?<=[.!?])\s+/));
    prose = [];
  };
  for (const line of String(text).replace(/```[\s\S]*?(```|$)/g, '\n').split('\n')) {
    const item = line.match(LIST_ITEM);
    if (item) {
      flush();
      parts.push(item[1]);
    } else {
      prose.push(line);
    }
  }
  flush();
  return parts
    .map((p) => p.trim())
    .filter((p) => p.length >= MIN_PART_CHARS)
    .slice(0, MAX_PARTS)
    .map((p) => clip(p, PART_CHARS));
}

function buildRequest(request, reply) {
  const parts = splitParts(clip(redact(request), REQUEST_CHARS));
  const questions = {};
  parts.forEach((part, i) => {
    questions[`p${i + 1}`] = {
      type: 'noul',
      instructions: `Does the reply do or answer this part of the request, or explain why it did not? Part: "${part}"`,
      criteria: {
        true: 'the reply does, answers, or explains skipping it; or the part asks for nothing (context, a remark)',
        false: 'the part asks for something the reply neither does nor mentions',
      },
    };
  });
  questions.asks_user = {
    type: 'noul',
    instructions: 'Does the reply end by asking the user a question or for a decision before going on?',
    criteria: {
      true: 'it waits on the user: a clarifying question, a choice, or approval to proceed',
      false: 'it reports finished work or answers without waiting on the user',
    },
  };
  const state = {
    request: clip(redact(request), REQUEST_CHARS),
    reply: clip(redact(reply), REPLY_CHARS),
  };
  return { state, questions, parts };
}

function missedParts(answers, parts) {
  const asks = answers.asks_user && answers.asks_user.noul;
  if (Number.isFinite(asks) && asks >= ASKS_USER) return [];
  return parts.filter((_, i) => {
    const value = answers[`p${i + 1}`] && answers[`p${i + 1}`].noul;
    return Number.isFinite(value) && value < COVERED;
  });
}

function reasonText(missed) {
  return [
    'Jev completeness check: the reply may not cover these parts of the request:',
    ...missed.map((p) => `- "${p}"`),
    'Finish them, or say briefly why they were skipped. This check runs once per turn.',
  ].join('\n');
}

// The prompt that started this turn, or null when that was a slash command
// or other harness entry (checking an older request would be wrong).
function lastRequest(transcriptPath) {
  let text;
  try { text = readTail(transcriptPath); } catch (e) { return null; }
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    let entry;
    try { entry = JSON.parse(lines[i]); } catch (e) { continue; }
    if (entry.type !== 'user' || entry.isSidechain || entry.isMeta) continue;
    const content = entry.message && entry.message.content;
    if (Array.isArray(content) && content.some((b) => b.type === 'tool_result')) continue;
    return userText(entry);
  }
  return null;
}

async function handle(hookInput, { ask = askJev, env = process.env } = {}) {
  const state = st.readState();
  if (!state.enabled || !state.completeCheck || hookInput.stop_hook_active) return null;
  const project = st.readProjectConfig(st.projectDir(hookInput.cwd));
  if (project && !project.router) return null;
  const apiKey = env.OPENROUTER_API_KEY;
  const reply = (hookInput.last_assistant_message || '').trim();
  if (!apiKey || !reply || !hookInput.transcript_path) return null;
  const request = lastRequest(hookInput.transcript_path);
  if (!request || require('./jev-router').looksSkippable(request)) return null;
  const { state: jevState, questions, parts } = buildRequest(request, reply);
  if (parts.length === 0) return null;

  let missed;
  try {
    const data = await ask(jevState, questions, { apiKey, timeoutMs: TIMEOUT_MS });
    const answers = (data && data.answers) || {};
    if (!answers.p1) throw new Error('response had no part answers');
    missed = missedParts(answers, parts);
    st.addCost(state, 'check', data.usage && data.usage.cost);
    state.lastCall = { at: new Date().toISOString(), ok: true };
  } catch (e) {
    state.lastCall = { at: new Date().toISOString(), ok: false, error: e.name === 'AbortError' ? 'timeout' : e.message };
    st.writeState(state);
    return null;
  }
  state.stats.checks = (state.stats.checks || 0) + 1;
  if (missed.length > 0) state.stats.checkBlocks = (state.stats.checkBlocks || 0) + 1;
  st.writeState(state);
  if (missed.length === 0) return null;
  return {
    decision: 'block',
    reason: reasonText(missed),
    systemMessage: `Jev: the reply may have missed ${missed.length} part${missed.length === 1 ? '' : 's'} of your request; Claude continues once to check.`,
  };
}

module.exports = { splitParts, buildRequest, missedParts, reasonText, lastRequest, handle, MAX_PARTS, PART_CHARS, REPLY_CHARS };

if (require.main === module) {
  let input = '';
  process.stdin.on('data', (chunk) => { input += chunk; });
  process.stdin.on('end', async () => {
    try {
      const out = await handle(JSON.parse(input || '{}'));
      if (out) process.stdout.write(JSON.stringify(out));
    } catch (e) {
      // Never hold up a stop over the check.
    }
  });
}
