// Distance-scaled retry scheduling for live-room self-heal reconnects.
//
// THE BUG THIS FIXES: live.html's self-heal loop used to retry every missing
// lower-seat connection on a flat 10s threshold, checked by every peer on the
// same synchronized 5s setInterval. If one peer (say, seat 0) had a
// transient failure that dropped its links to several higher-seat peers at
// once, every one of those peers independently noticed on the same tick and
// dialed at the same moment - a burst of simultaneous connection attempts
// landing on the one peer least able to handle them right after it was
// already struggling.
//
// Adapts part of the request-timer mechanism from Floyd/Jacobson/Liu/
// McCanne/Zhang, "A Reliable Multicast Framework for Light-weight Sessions
// and Application Level Framing" (SIGCOMM 1995, the SRM paper): each
// watcher's wait before retrying is scaled by its own distance estimate to
// the target, `wait ~ [C1*d, (C1+C2)*d]`, spreading a simultaneous burst
// into a staggered trickle instead of a synchronized pileup.
//
// WHAT DID NOT CARRY OVER FROM SRM, AND WHY: SRM's request timers also
// include suppression - a receiver cancels its own repair request the
// moment it hears someone else's request for the same data, because in
// multicast, any peer that answers satisfies every listener at once. That
// does not hold here: if peer B reconnects to peer A, peer C's own broken
// link to A is still broken, so C's attempt is not interchangeable with B's.
// This module only adapts the part that does transfer: scaling each
// watcher's own wait by distance.
//
// See research/retry-scheduling/FINDINGS.md for the measurements that
// justified this, including the honest negative result that staggering the
// wait alone does nothing under a poll-based outer loop - the caller must
// fire on the computed time (setTimeout), not just check it at the next
// tick. live.html does the latter; see its retryTimers usage.
//
// Pure logic, no timers, no network: callers push events in (scheduleRetry,
// onAttempt) and ask due(now) to get who should fire this tick. That is what
// makes this testable against a fake clock, matching the harness pattern
// used for heartbeat-detector.js.

// ---- baseline: what live.html did before this change -----------------------
// Fixed interval, no jitter, no distance signal. Kept here for comparison in
// tests, not used in production.
class SynchronizedRetry {
  constructor() {
    this.lastTry = new Map(); // targetId -> ms of last attempt
    this.INTERVAL_MS = 10000;
  }
  scheduleRetry(targetId, _now, _distanceMs) {
    if (!this.lastTry.has(targetId)) this.lastTry.set(targetId, 0);
  }
  due(now) {
    const fire = [];
    for (const [targetId, last] of this.lastTry) {
      if (now - last >= this.INTERVAL_MS) fire.push(targetId);
    }
    return fire;
  }
  onAttempt(targetId, now) { this.lastTry.set(targetId, now); }
}

// ---- production: SRM-style distance-scaled wait, no cross-peer suppression -
// distanceMs is this watcher's own estimate of how far the target is - in
// live.html that's last-measured RTT via getStats(), falling back to a fixed
// default if no estimate exists yet, exactly as SRM's own wb implementation
// used a fixed default before it had real distance data.
class StaggeredRetry {
  constructor({ C1 = 1, C2 = 1, rand = Math.random } = {}) {
    this.C1 = C1;
    this.C2 = C2;
    this.rand = rand;
    this.pending = new Map(); // targetId -> fireAt ms
  }
  scheduleRetry(targetId, now, distanceMs = 100) {
    if (this.pending.has(targetId)) return;
    const span = this.C2 * distanceMs;
    const wait = this.C1 * distanceMs + this.rand() * span;
    this.pending.set(targetId, now + wait);
  }
  due(now) {
    const fire = [];
    for (const [targetId, at] of this.pending) {
      if (now >= at) fire.push(targetId);
    }
    return fire;
  }
  onAttempt(targetId, now) { this.pending.delete(targetId); }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { SynchronizedRetry, StaggeredRetry };
}
if (typeof window !== 'undefined') {
  window.MeshareRetry = { SynchronizedRetry, StaggeredRetry };
}
