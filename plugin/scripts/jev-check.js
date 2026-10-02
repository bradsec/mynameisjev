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

const path = require('path');
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
// Edits made this turn: files judged for scope, the change excerpt sent per
// file, and all excerpts together. Files past these go by path only.
const MAX_FILES = 8;
const EDIT_CHARS = 600;
const EDITS_CHARS = 8000;
const EDIT_TOOLS = ['Edit', 'MultiEdit', 'Write', 'NotebookEdit'];
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

function buildRequest(request, reply, edits = []) {
  const parts = splitParts(clip(redact(request), REQUEST_CHARS));
  const questions = {};
  const judged = [];
  let budget = EDITS_CHARS;
  for (const e of edits) {
    if (judged.length >= MAX_FILES || budget <= 0) break;
    const change = clip(redact(e.text || ''), Math.min(EDIT_CHARS, budget));
    budget -= change.length;
    judged.push({ file: redact(e.file), change });
  }
  const files = judged.map((e) => e.file);
  const by = files.length > 0 ? 'reply, or the edits made this turn,' : 'reply';
  parts.forEach((part, i) => {
    questions[`p${i + 1}`] = {
      type: 'noul',
      instructions: `Does the ${by} do or answer this part of the request, or explain why it did not? Part: "${part}"`,
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
  files.forEach((file, i) => {
    questions[`f${i + 1}`] = {
      type: 'noul',
      instructions: `Is the edit to ${file} made this turn needed for the request?`,
      criteria: {
        true: 'the request asks for it, or it is a test, doc or config change the requested work needs',
        false: 'it changes something the request did not ask for and the work does not need',
      },
    };
  });
  const state = {
    request: clip(redact(request), REQUEST_CHARS),
    reply: clip(redact(reply), REPLY_CHARS),
  };
  if (judged.length > 0) state.edits = judged;
  const others = edits.slice(judged.length).map((e) => redact(e.file));
  if (others.length > 0) state.other_edited_files = others;
  return { state, questions, parts, files };
}

// The items whose key (prefix + index) scores below COVERED, or none when
// Claude is waiting on the user.
function lowScoring(answers, items, prefix) {
  const asks = answers.asks_user && answers.asks_user.noul;
  if (Number.isFinite(asks) && asks >= ASKS_USER) return [];
  return items.filter((_, i) => {
    const value = answers[`${prefix}${i + 1}`] && answers[`${prefix}${i + 1}`].noul;
    return Number.isFinite(value) && value < COVERED;
  });
}

const missedParts = (answers, parts) => lowScoring(answers, parts, 'p');
const unrelatedFiles = (answers, files) => lowScoring(answers, files, 'f');

function reasonText(missed, unrelated = []) {
  const lines = ['Jev completeness check:'];
  if (missed.length > 0) lines.push('The reply may not cover these parts of the request:', ...missed.map((p) => `- "${p}"`));
  if (unrelated.length > 0) lines.push('These edits may go beyond the request:', ...unrelated.map((f) => `- ${f}`));
  const asks = [missed.length > 0 ? 'finish the missing parts' : null, unrelated.length > 0 ? 'revert unrelated edits' : null].filter(Boolean);
  lines.push(`${asks.join(', ').replace(/^./, (c) => c.toUpperCase())}, or say briefly why. This check runs once per turn.`);
  return lines.join('\n');
}

// What an edit tool call changed: its new text, for the scope question.
function editText(name, input) {
  if (name === 'Edit') return input.new_string;
  if (name === 'MultiEdit') return (input.edits || []).map((e) => e.new_string).join('\n');
  if (name === 'Write') return input.content;
  return input.new_source;
}

// The prompt that started this turn and the files edited since, in first-
// edit order: { request, edits: [{ file, text }] }. request is null when the
// turn started with a slash command or other harness entry (checking an
// older request would be wrong). Paths under cwd are relative to it.
function lastTurn(transcriptPath, cwd) {
  let text;
  try { text = readTail(transcriptPath); } catch (e) { return { request: null, edits: [] }; }
  const lines = text.split('\n');
  const uses = [];
  let request = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    let entry;
    try { entry = JSON.parse(lines[i]); } catch (e) { continue; }
    if (entry.isSidechain) continue;
    const content = entry.message && entry.message.content;
    if (entry.type === 'assistant' && Array.isArray(content)) {
      for (const b of content.slice().reverse()) {
        if (b.type === 'tool_use' && EDIT_TOOLS.includes(b.name) && b.input) uses.unshift(b);
      }
      continue;
    }
    if (entry.type !== 'user' || entry.isMeta) continue;
    if (Array.isArray(content) && content.some((b) => b.type === 'tool_result')) continue;
    request = userText(entry);
    break;
  }
  const byFile = new Map();
  for (const u of uses) {
    const abs = u.input.file_path || u.input.notebook_path;
    if (typeof abs !== 'string') continue;
    const rel = cwd ? path.relative(cwd, abs) : abs;
    const file = rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : abs;
    const change = editText(u.name, u.input);
    byFile.set(file, [...(byFile.get(file) || []), typeof change === 'string' ? change : '']);
  }
  return { request, edits: [...byFile].map(([file, texts]) => ({ file, text: texts.filter(Boolean).join('\n...\n') })) };
}

async function handle(hookInput, { ask = askJev, env = process.env } = {}) {
  const state = st.readState();
  if (!state.enabled || !state.completeCheck || hookInput.stop_hook_active) return null;
  const project = st.readProjectConfig(st.projectDir(hookInput.cwd));
  if (project && !project.router) return null;
  const apiKey = env.OPENROUTER_API_KEY;
  const reply = (hookInput.last_assistant_message || '').trim();
  if (!apiKey || !reply || !hookInput.transcript_path) return null;
  const { request, edits } = lastTurn(hookInput.transcript_path, hookInput.cwd);
  if (!request || require('./jev-router').looksSkippable(request)) return null;
  const { state: jevState, questions, parts, files } = buildRequest(request, reply, edits);
  if (parts.length === 0) return null;

  let missed;
  let unrelated;
  try {
    const data = await ask(jevState, questions, { apiKey, timeoutMs: TIMEOUT_MS });
    const answers = (data && data.answers) || {};
    if (!answers.p1) throw new Error('response had no part answers');
    missed = missedParts(answers, parts);
    unrelated = unrelatedFiles(answers, files);
    st.addCost(state, 'check', data.usage && data.usage.cost);
    state.lastCall = { at: new Date().toISOString(), ok: true };
  } catch (e) {
    state.lastCall = { at: new Date().toISOString(), ok: false, error: e.name === 'AbortError' ? 'timeout' : e.message };
    st.writeState(state);
    return null;
  }
  state.stats.checks = (state.stats.checks || 0) + 1;
  if (missed.length > 0 || unrelated.length > 0) state.stats.checkBlocks = (state.stats.checkBlocks || 0) + 1;
  if (unrelated.length > 0) state.stats.checkScope = (state.stats.checkScope || 0) + 1;
  st.writeState(state);
  if (missed.length === 0 && unrelated.length === 0) return null;
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const found = [
    missed.length > 0 ? `the reply may have missed ${plural(missed.length, 'part')} of your request` : null,
    unrelated.length > 0 ? `${plural(unrelated.length, 'edited file')} may go beyond ${missed.length > 0 ? 'it' : 'your request'}` : null,
  ].filter(Boolean).join(', and ');
  return {
    decision: 'block',
    reason: reasonText(missed, unrelated),
    systemMessage: `Jev: ${found}; Claude continues once to check.`,
  };
}

module.exports = {
  splitParts, buildRequest, missedParts, unrelatedFiles, reasonText, lastTurn, handle,
  MAX_PARTS, PART_CHARS, REPLY_CHARS, MAX_FILES, EDIT_CHARS,
};

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
