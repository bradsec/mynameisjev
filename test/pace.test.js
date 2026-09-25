const test = require('node:test');
const assert = require('node:assert');
const pace = require('../plugin/scripts/jev-pace');

const now = 1_800_000_000_000;
const reset = now / 1000 + 3 * 3600;
const saved = (pct, history) => ({ five_hour: { used_percentage: pct, resets_at: reset }, history });
const sample = (minsAgo, pct, r = reset) => ({ at: now - minsAgo * 60000, pct, reset: r });

test('pace: rise over the last hour projects time to 100%', () => {
  // 40% -> 60% over 40 minutes: 30%/h, 40% left: 80 minutes.
  const p = pace.pace(saved(60, [sample(40, 40), sample(0, 60)]), now);
  assert.strictEqual(Math.round(p.perHour), 30);
  assert.strictEqual(Math.round(p.minutesToFull), 80);
  assert.strictEqual(p.beforeReset, true);
});

test('pace: too little history, a short span, or other windows give no projection', () => {
  assert.strictEqual(pace.pace(saved(60, [sample(0, 60)]), now), null);
  assert.strictEqual(pace.pace(saved(60, [sample(5, 55), sample(0, 60)]), now), null, 'under 10 minutes');
  assert.strictEqual(pace.pace(saved(60, [sample(40, 40, reset - 18000), sample(0, 60)]), now), null, 'earlier window');
  assert.strictEqual(pace.pace(saved(60, [sample(90, 10), sample(0, 60)]), now), null, 'older than an hour');
  assert.deepStrictEqual(pace.pace(saved(60, [sample(40, 60), sample(0, 60)]), now), { perHour: 0, minutesToFull: null, beforeReset: false });
});

test('pace: a slow rise that outlasts the window is not before the reset', () => {
  // 5%/h from 50%: 10 hours to full, window resets in 3.
  assert.strictEqual(pace.pace(saved(50, [sample(60, 45), sample(0, 50)]), now).beforeReset, false);
});

test('pace routes only from 60% and within 90 minutes of running out', () => {
  const fast = { beforeReset: true, minutesToFull: 45 };
  assert.ok(pace.paceRoutes(65, fast));
  assert.ok(!pace.paceRoutes(55, fast));
  assert.ok(!pace.paceRoutes(65, { beforeReset: true, minutesToFull: 120 }));
  assert.ok(!pace.paceRoutes(65, null));
});

test('recordSample: appends changes only, drops other windows', () => {
  let h = pace.recordSample([sample(10, 30, reset - 18000)], { used_percentage: 40, resets_at: reset }, now);
  assert.deepStrictEqual(h.map((s) => s.pct), [40]);
  h = pace.recordSample(h, { used_percentage: 40, resets_at: reset }, now + 1000);
  assert.strictEqual(h.length, 1);
  h = pace.recordSample(h, { used_percentage: 42, resets_at: reset }, now + 2000);
  assert.deepStrictEqual(h.map((s) => s.pct), [40, 42]);
});

test('fmtMinutes', () => {
  assert.strictEqual(pace.fmtMinutes(42.4), '~42m');
  assert.strictEqual(pace.fmtMinutes(95), '~1h 35m');
});
