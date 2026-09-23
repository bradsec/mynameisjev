#!/usr/bin/env node
// jev-model-switch — PostModelSwitch hook. Records the session's new model so
// jev-router knows it before the new model's first reply reaches the
// transcript (the router's only other model source).
//
// Writes its own file (session-models.json) rather than the router state:
// the router rewrites that state after a network call, which would clobber a
// switch recorded meanwhile.
// Never blocks and prints nothing, so Claude's context is unchanged.

const fs = require('fs');
const st = require('./jev-state');

// One entry per session; old sessions are dropped so the file stays small.
const MAX_SESSIONS = 20;

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return null;
  }
}

let input = '';
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  try {
    if (!st.readState().enabled) return;

    const hookInput = JSON.parse(input);
    const sessionId = hookInput.session_id;
    const model = hookInput.to_model;
    if (typeof sessionId !== 'string' || typeof model !== 'string') return;

    const modelsPath = st.dataFile('session-models.json');
    const models = readJson(modelsPath) || {};
    models[sessionId] = { model, at: new Date().toISOString() };
    const kept = Object.entries(models)
      .sort((a, b) => String(b[1].at).localeCompare(String(a[1].at)))
      .slice(0, MAX_SESSIONS);
    fs.writeFileSync(modelsPath, JSON.stringify(Object.fromEntries(kept), null, 2));
  } catch (e) {
    // Silent fail: the router falls back to the transcript.
  }
});
