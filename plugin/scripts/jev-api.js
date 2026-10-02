// jev-api — one call to Jev, OpenRouter's structured decision model. Shared
// by the router hook (sizing each message) and /mynameisjev:decide. Callers
// redact what they put in `state` and `questions` (jev-redact.js).

const ENDPOINT = 'https://openrouter.ai/api/alpha/decisions';
const MODEL = 'typesafe/jev-1.13';

// Returns the parsed response ({ answers, usage }). Throws on a non-2xx
// status or a body that is not JSON; a timeout throws fetch's AbortError
// unchanged, which callers check by name.
async function askJev(state, questions, { apiKey, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model: MODEL, state, questions }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { askJev };
