// Deterministic simulation: N watchers all lose their connection to the same
// target at the same instant (one peer's transient failure dropping several
// links at once) and all start retrying. Compares SynchronizedRetry (live.html's
// old behavior) against StaggeredRetry (production since this change) on how
// bunched the resulting connection attempts are.
const test = require('node:test');
const assert = require('node:assert/strict');
const { SynchronizedRetry, StaggeredRetry } = require('./retry-scheduler.js');

const TICK_MS = 5000; // matches live.html's old setInterval-only cadence

// POLLED harness: due() is only ever checked at 5s tick boundaries, matching
// how live.html's self-heal loop worked before this change.
function simulatePolled(SchedulerClass, watcherCount, distances, endMs, opts) {
  const schedulers = Array.from({ length: watcherCount }, () => new SchedulerClass(opts));
  const attempts = [];
  for (let t = 0; t <= endMs; t += TICK_MS) {
    for (let w = 0; w < watcherCount; w++) {
      schedulers[w].scheduleRetry('target', t, distances[w]);
      for (const targetId of schedulers[w].due(t)) {
        schedulers[w].onAttempt(targetId, t);
        attempts.push({ watcher: w, t });
      }
    }
  }
  return attempts;
}

// CONTINUOUS harness: fires each watcher's very first scheduled attempt at
// its true computed time, not rounded up to the next poll. This is what
// live.html's retryTimers now actually does with setTimeout.
function simulateFirstAttempt(SchedulerClass, distanceMs, opts) {
  const s = new SchedulerClass(opts);
  s.scheduleRetry('target', 0, distanceMs);
  if (s.due) {
    if (s.pending) return s.pending.get('target');
    return s.INTERVAL_MS;
  }
}

const COLLISION_WINDOW_MS = 250;
function countCollisions(attempts) {
  const sorted = attempts.slice().sort((a, b) => a.t - b.t);
  let collisions = 0, maxBunch = 1, i = 0;
  while (i < sorted.length) {
    let j = i;
    const watchersInWindow = new Set();
    while (j < sorted.length && sorted[j].t - sorted[i].t <= COLLISION_WINDOW_MS) {
      watchersInWindow.add(sorted[j].watcher);
      j++;
    }
    if (watchersInWindow.size > 1) { collisions++; maxBunch = Math.max(maxBunch, watchersInWindow.size); }
    i = j;
  }
  return { collisions, maxBunch };
}

test('5 watchers, same distance, under plain polling: old scheduler bunches every single attempt', () => {
  const distances = [100, 100, 100, 100, 100]; // no distance information available - the common case
  const sync = simulatePolled(SynchronizedRetry, 5, distances, 30000);
  const stag = simulatePolled(StaggeredRetry, 5, distances, 30000, { C1: 1, C2: 4 });

  const syncStats = countCollisions(sync);
  const stagStats = countCollisions(stag);

  console.log(`  [equal-distance] sync attempts:  ${sync.map(a => `w${a.watcher}@${a.t}`).join(', ')}`);
  console.log(`  [equal-distance] sync: ${syncStats.collisions} collision window(s), max ${syncStats.maxBunch} simultaneous`);
  console.log(`  [equal-distance] stag attempts:  ${stag.map(a => `w${a.watcher}@${a.t}`).join(', ')}`);
  console.log(`  [equal-distance] staggered: ${stagStats.collisions} collision window(s), max ${stagStats.maxBunch} simultaneous`);

  assert.equal(syncStats.maxBunch, 5, 'the old scheduler produces a full 5-way pileup, every single time');
  // Honest limitation, not hidden: under PURE POLLING, staggering the
  // underlying wait still gets rounded up to the same 5s tick boundary as
  // everyone else whenever the computed wait is smaller than one tick, so it
  // does NOT reduce bunching by itself. This is exactly why live.html fires
  // retries via setTimeout at the computed time instead of relying on the
  // 5s heartbeat tick to notice - see next test.
  assert.equal(stagStats.maxBunch, 5, 'staggering alone, under pure polling, does not fix the pileup - see next test');
});

test('the actual fix requires firing on the computed time, not the next poll tick', () => {
  const distances = [20, 60, 100, 200, 400];
  const fireTimes = distances.map(d => simulateFirstAttempt(StaggeredRetry, d, { C1: 1, C2: 1 }));
  console.log(`  [true-timing] distances: ${distances.join(', ')}`);
  console.log(`  [true-timing] computed fire times: ${fireTimes.join(', ')}`);

  const spread = Math.max(...fireTimes) - Math.min(...fireTimes);
  console.log(`  [true-timing] spread across watchers: ${spread}ms (all would land in the same 250ms window if unstaggered)`);

  for (let i = 1; i < fireTimes.length; i++) {
    assert.ok(fireTimes[i] > fireTimes[i - 1], `distance ${distances[i]} should fire after distance ${distances[i - 1]}`);
  }
  assert.ok(spread > COLLISION_WINDOW_MS, 'staggered fire times should spread well beyond one collision window');
});

test('null control: at equal distance with C2=0, staggering degenerates to the same fixed wait, no phantom spread', () => {
  const distances = [100, 100, 100];
  const fireTimes = distances.map(d => simulateFirstAttempt(StaggeredRetry, d, { C1: 1, C2: 0 }));
  console.log(`  [null control] C2=0 fire times (should be identical): ${fireTimes.join(', ')}`);
  assert.ok(fireTimes.every(t => t === fireTimes[0]), 'with zero randomness, all equal-distance watchers must still coincide - the spread comes from C2, not from nothing');
});

test('a lone watcher with a persistent failure keeps retrying, not just once', () => {
  const distances = [100];
  const stag = simulatePolled(StaggeredRetry, 1, distances, 30000, { C1: 1, C2: 1 });
  console.log(`  [persistent] lone watcher attempts over 30s: ${stag.map(a => a.t).join(', ')}`);
  assert.ok(stag.length >= 2, 'a still-missing peer should be retried more than once over 30 seconds');
  const gaps = stag.slice(1).map((a, i) => a.t - stag[i].t);
  assert.ok(gaps.every(g => g > 0), 'successive retries for the same watcher must never coincide with each other');
});
