// jev-pace — how fast Claude's 5-hour plan usage is rising, and whether it
// will reach 100% before the window resets.
//
// The status line records a sample each time the 5h percentage changes
// (recordSample, kept in claude-limits.json as `history`). The pace is the
// rise over the last hour of samples in the current window. Samples only
// arrive while Claude is working, so the pace describes working time: an
// idle break does not lower it.

// Samples older than this don't count towards the pace.
const PACE_WINDOW_MS = 60 * 60 * 1000;
// A shorter span is too noisy to project from.
const MIN_SPAN_MS = 10 * 60 * 1000;
// History kept per window.
const MAX_SAMPLES = 100;
// Pace-based routing starts at this usage when the projection reaches 100%
// before the reset within PACE_ROUTE_MINUTES. Below it, a busy start to a
// window would move work to Codex on too little evidence.
const PACE_ROUTE_MIN_PCT = 60;
const PACE_ROUTE_MINUTES = 90;

// Adds the current 5h percentage to `history` when it changed. Samples from
// an earlier window (another resets_at) are dropped.
function recordSample(history, fiveHour, nowMs) {
  const kept = (Array.isArray(history) ? history : [])
    .filter((s) => s && s.reset === fiveHour.resets_at && nowMs - s.at <= 5 * 60 * 60 * 1000);
  const last = kept[kept.length - 1];
  if (!last || last.pct !== fiveHour.used_percentage) {
    kept.push({ at: nowMs, pct: fiveHour.used_percentage, reset: fiveHour.resets_at });
  }
  return kept.slice(-MAX_SAMPLES);
}

// The pace for saved limits ({ five_hour, history }), or null without
// enough samples: { perHour, minutesToFull, beforeReset }. minutesToFull is
// null when usage isn't rising.
function pace(saved, nowMs) {
  const five = saved && saved.five_hour;
  if (!five || !Number.isFinite(five.used_percentage) || !Number.isFinite(five.resets_at)) return null;
  const samples = (Array.isArray(saved.history) ? saved.history : [])
    .filter((s) => s && s.reset === five.resets_at && Number.isFinite(s.pct) && nowMs - s.at <= PACE_WINDOW_MS);
  if (samples.length < 2) return null;
  const first = samples[0];
  const last = samples[samples.length - 1];
  const span = last.at - first.at;
  if (span < MIN_SPAN_MS) return null;
  const rise = last.pct - first.pct;
  if (rise <= 0) return { perHour: 0, minutesToFull: null, beforeReset: false };
  const perMinute = rise / (span / 60000);
  const fullAt = last.at + ((100 - five.used_percentage) / perMinute) * 60000;
  return {
    perHour: perMinute * 60,
    minutesToFull: Math.max(0, (fullAt - nowMs) / 60000),
    beforeReset: fullAt < five.resets_at * 1000,
  };
}

// Whether the pace alone should move work to Codex at this usage.
function paceRoutes(pct, p) {
  return !!p && pct >= PACE_ROUTE_MIN_PCT && p.beforeReset && p.minutesToFull !== null && p.minutesToFull <= PACE_ROUTE_MINUTES;
}

// "~40m" or "~1h 20m".
function fmtMinutes(m) {
  const mins = Math.max(1, Math.round(m));
  return mins >= 60 ? `~${Math.floor(mins / 60)}h ${mins % 60}m` : `~${mins}m`;
}

module.exports = { recordSample, pace, paceRoutes, fmtMinutes, PACE_ROUTE_MIN_PCT, PACE_ROUTE_MINUTES };
