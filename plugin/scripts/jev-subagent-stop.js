#!/usr/bin/env node
// jev-subagent-stop — SubagentStop hook. When a mynameisjev:* helper
// finishes, adds up the tokens its transcript records per model and keeps
// the totals in state.helperTokens for `/mynameisjev:report`.
//
// The hook input names the subagent but not its token use, so this reads the
// subagent's transcript: agent_transcript_path when Claude Code sends it,
// else <session transcript dir>/<session id>/subagents/agent-<agent id>.jsonl.

const fs = require('fs');
const path = require('path');
const st = require('./jev-state');

const MODEL_FAMILIES = ['haiku', 'sonnet', 'opus', 'fable'];

function transcriptPath(hookInput) {
  if (hookInput.agent_transcript_path) return hookInput.agent_transcript_path;
  if (!hookInput.transcript_path || !hookInput.session_id || !hookInput.agent_id) return null;
  return path.join(path.dirname(hookInput.transcript_path), hookInput.session_id, 'subagents', `agent-${hookInput.agent_id}.jsonl`);
}

// Token use per model family in a transcript. Claude Code writes one entry
// per content block of a reply, each repeating the reply's usage, so replies
// are counted once by message id.
function tokenUse(text) {
  const seen = new Set();
  const byModel = {};
  for (const line of text.split('\n')) {
    if (!line.includes('"usage"')) continue;
    let entry;
    try { entry = JSON.parse(line); } catch (e) { continue; }
    const msg = entry.message;
    if (entry.type !== 'assistant' || !msg || !msg.usage) continue;
    if (msg.id) {
      if (seen.has(msg.id)) continue;
      seen.add(msg.id);
    }
    const family = MODEL_FAMILIES.find((f) => typeof msg.model === 'string' && msg.model.includes(f));
    if (!family) continue;
    const u = msg.usage;
    const t = byModel[family] || (byModel[family] = { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 });
    t.input += u.input_tokens || 0;
    t.cacheWrite += u.cache_creation_input_tokens || 0;
    t.cacheRead += u.cache_read_input_tokens || 0;
    t.output += u.output_tokens || 0;
  }
  return byModel;
}

// Adds a finished helper's token use to the state. Returns the per-model use
// recorded, or null when the subagent isn't a helper or has no transcript.
function record(hookInput) {
  if (typeof hookInput.agent_type !== 'string' || !hookInput.agent_type.startsWith('mynameisjev:')) return null;
  const state = st.readState();
  if (!state.enabled) return null;
  const file = transcriptPath(hookInput);
  if (!file) return null;
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    return null;
  }
  const use = tokenUse(text);
  for (const [family, t] of Object.entries(use)) {
    const total = state.helperTokens[family] || { runs: 0, input: 0, cacheWrite: 0, cacheRead: 0, output: 0 };
    state.helperTokens[family] = {
      runs: total.runs + 1,
      input: total.input + t.input,
      cacheWrite: total.cacheWrite + t.cacheWrite,
      cacheRead: total.cacheRead + t.cacheRead,
      output: total.output + t.output,
    };
  }
  st.writeState(state);
  return use;
}

module.exports = { record, tokenUse, transcriptPath };

if (require.main === module) {
  let input = '';
  process.stdin.on('data', (chunk) => { input += chunk; });
  process.stdin.on('end', () => {
    try {
      record(JSON.parse(input || '{}'));
    } catch (e) {
      // Stats only: never disturb the session over them.
    }
  });
}
