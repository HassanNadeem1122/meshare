# Retry scheduling for live-room self-heal: does staggering by distance stop reconnect storms?

Applies part of the request-timer mechanism from Floyd, Jacobson, Liu, McCanne
and Zhang, "A Reliable Multicast Framework for Light-weight Sessions and
Application Level Framing" (SIGCOMM 1995, the SRM paper), to a problem it was
not built for: point-to-point WebRTC reconnection instead of multicast data
repair. **This one shipped.** The result is in production
(`app/public/retry-scheduler.js`, wired into `app/public/live.html`), verified
live with a real three-peer WebRTC session.

## Problem

meshare's live rooms are a full mesh: every peer holds one data channel to
every other peer. If a member's link drops (wifi handoff, tab sleep, a
transient signaling hiccup) without a clean `close`, every other peer that
lost the link notices independently and redials.

Before this change, `live.html`'s self-heal loop retried on a flat 10s
threshold, checked by every peer on the same synchronized 5s `setInterval`.
If one peer had a transient failure that dropped its links to several other
peers at once, every peer that lost it noticed on the same tick and dialed
back at the same moment - a burst of simultaneous connection attempts landing
on the one peer least able to handle them right after it was already
struggling. In an 8-seat full-mesh room, a single peer's blip could produce a
7-way simultaneous redial.

SRM solves an analogous problem for multicast repair requests by scaling each
receiver's wait by its distance from the loss, `wait ~ [C1*d, (C1+C2)*d]`,
so requests from receivers at different distances land at different times
instead of all firing on the same RTT-driven clock edge. The question: does
adapting that scaling (without SRM's multicast-specific suppression, which
doesn't apply here - see Method) fix the pileup, and is scaling the wait
alone enough, or does the outer scheduling loop have to change too?

## Method

Two schedulers, compared in a deterministic fake-clock harness
(`app/public/retry-scheduler.test.js`) before touching production:

| Scheduler | Behaviour |
|---|---|
| `SynchronizedRetry` | today's behaviour: fixed 10s threshold, no jitter, no distance signal |
| `StaggeredRetry` | wait drawn from `[C1*d, (C1+C2)*d]`, `d` = this watcher's own distance estimate to the target |

**What did not carry over from SRM, and why.** SRM's request timers also
include suppression: a receiver cancels its own pending request the moment it
hears someone else's request for the same data, because in multicast any
peer's answer satisfies every listener at once. That precondition does not
hold here. If peer B successfully reconnects to peer A, peer C's own broken
link to A is still broken - C's connection attempt is not interchangeable
with B's. Building in cross-peer suppression would have been a mechanical
transplant of a mechanism whose justification doesn't hold in this topology,
so only the distance-scaled wait was adapted, not suppression.

**Two harnesses, on purpose:**
- `simulatePolled` checks `due()` only at 5s tick boundaries, matching
  exactly how the old `setInterval`-only loop worked. This is the fair
  comparison against real prior behaviour.
- `simulateFirstAttempt` reads each scheduler's true computed fire time
  directly, isolating what the staggering algorithm itself does, decoupled
  from any outer polling loop.

**Null control:** `StaggeredRetry` with `C2=0` must degenerate to the same
fixed wait as `SynchronizedRetry` for equal-distance watchers, proving any
observed spread comes from the `C2` term and not from a harness artifact.

## Results

**Under the old poll-only loop, staggering the wait alone changes nothing.**
Five watchers at equal distance, checked only at 5s ticks:

```
sync attempts:  w0@10000, w1@10000, w2@10000, w3@10000, w4@10000, ...
stag attempts:  w0@5000,  w1@5000,  w2@5000,  w3@5000,  w4@5000,  ...
```

`SynchronizedRetry`: 5-way simultaneous pileup, every time (expected - this is
the documented bug). `StaggeredRetry` under the same poll loop: **also a
5-way simultaneous pileup**, just shifted earlier. This is an honest negative
result, not a footnote: a short computed wait (single-digit to low-hundreds
of ms at typical LAN/WAN distances) still gets rounded up to the same 5s tick
boundary as every other watcher, because the outer loop only ever samples
`due()` once per tick. Swapping the scheduler class alone does not fix the
bug.

**Firing on the computed time, not the next poll tick, does.** Same five
distances (20/60/100/200/400 ms), scheduler's real fire time read directly:

```
distances:            20,     60,     100,    200,    400
computed fire times:   30ms,   82ms,   125ms,  332ms,  725ms
```

Monotonic in distance, spread of 695ms across a 250ms collision window - each
watcher's attempt lands in its own window. This is what motivated the actual
production change: `live.html`'s self-heal now fires each retry on a
per-target `setTimeout` at the scheduler's computed time, not on the next 5s
heartbeat tick. The 5s loop still runs (it still owns the silent-peer sweep
and notices *new* gaps to schedule), but it no longer gates *when* a retry
fires once scheduled.

**Persistent failures still retry repeatedly, never colliding with
themselves:**

```
lone watcher attempts over 30s: 5000, 15000, 25000
```

A target that never comes back keeps getting retried, and successive retries
for the same watcher never land on the same instant as each other.

**Null control held:** with `C2=0`, all three equal-distance fire times were
identical (100, 100, 100) - confirming the spread in the real config comes
from the `C2` jitter term, not from measurement noise in the harness.

## Verification pass

Ran the corrected suite (`node --test retry-scheduler.test.js`) inside
`app/public/` against the actual module `live.html` now imports, not a
research-only copy - all 4 tests pass, same file the browser loads.

Three bugs were caught and fixed before trusting the result:

1. **`-Infinity` sentinel.** `SynchronizedRetry` initially treated an untried
   target as "never tried," firing instantly. Production's real guard is
   `now - (lastTry.get(id) || 0) > 10000`, which reads an unset target as
   "tried at time 0." Fixed the model to match, since the whole point of the
   baseline is fidelity to what's actually live.
2. **Wrong assertion about retry frequency.** An early test asserted a
   persistently-failing watcher should retry "exactly once ever." That's
   backwards: a target that stays down must keep being retried periodically,
   or self-heal stops healing. Rewrote to assert repeated retries that never
   self-collide.
3. **The granularity mismatch above** - caught by deliberately running the
   staggered scheduler through the *real* poll harness instead of only the
   idealized continuous-time one, which is what exposed that staggering alone
   doesn't help under polling.

**Live verification**, beyond the unit harness: three peers joined the same
room in three separate browser tabs (`app/public/live.html` served locally,
real PeerJS signaling, real STUN/TURN). One peer's connection to another was
force-closed to simulate a dropped link. Confirmed:
- `peerDistance` populated with a real measured RTT (via `getStats()`
  `currentRoundTripTime` on the selected candidate pair) after each connect,
  not just the 200ms default.
- The dropped peer was correctly removed from both sides' rosters (`... left`
  announced).
- Self-heal reconnected within one 5s notice tick plus the computed stagger
  wait, without waiting for a full 10s threshold.
- The roster correctly re-announced `... joined` once the asymmetric trust
  window passed on the new connection, and `peerDistance` was refreshed for
  the new link.
- No new console errors introduced; the only errors present (`ID "..." is
  taken`) are pre-existing PeerJS debug noise from the initial multi-tab
  `claimSeat()` race and are already handled by the existing `unavailable-id`
  retry path, unrelated to this change.

## Limitations

- **Single-machine testing.** All distance measurements in the live
  verification were sub-5ms (same machine, loopback-class network), too small
  to show visually distinct staggering. The *mechanism* was verified
  end-to-end (measurement, scheduling, timeout-based firing, reconnect); the
  *magnitude* of stagger at realistic internet RTTs (20-400ms, as used in the
  simulation) was not independently reproduced against real geographically
  distributed peers.
- **No cross-peer suppression**, by deliberate design choice (see Method) -
  this means in a genuine N-way simultaneous drop, N independent retries will
  still all eventually fire, just spread out in time rather than bunched.
  That is the intended tradeoff, not an oversight: correctness requires each
  peer to re-establish its own link regardless of what other peers do.
- **Distance estimate is last-known, not live.** `peerDistance` is set once
  per successful connection (via a single `getStats()` read, matching the
  existing `pathOf()` pattern in `index.html`) and reused for any future
  retry to that same peer. A peer whose network conditions changed
  significantly between disconnect and retry will schedule against a stale
  estimate. The 200ms default for a never-before-connected peer is a fixed
  constant carried over from SRM's own historical precedent (`wb`'s default
  before it had real distance data), not something tuned against meshare's
  own traffic.
- **`C1=1, C2=1` was not tuned.** These match SRM's own notation directly but
  the specific values were chosen for a clear, well-separated demonstration
  in the simulation, not fitted against meshare's real seat-drop frequency or
  room sizes. They are a reasonable starting point, not a measured optimum.

## Recommendation

Shipped as-is: the negative result (staggering alone does nothing under
polling) directly changed the implementation, not just the write-up -
`live.html` fires retries via `setTimeout` at the computed time rather than
merely swapping in a jittered wait inside the same poll loop. A future
follow-up worth doing if room sizes grow past the current 8-seat cap: measure
real stagger magnitude across actually distributed peers, and revisit
`C1`/`C2` against observed reconnect-storm frequency rather than the
simulation's illustrative distances.

## Reproducing

```bash
cd app/public
node --test retry-scheduler.test.js
```

Live verification: serve `app/public/` locally, open `live.html` in 3+
browser tabs/processes joining the same room name, force-close one peer's
connection to another via devtools (`conns.get(id).close()`), and confirm
`peerDistance`, `retryScheduler.pending`, and `retryTimers` in that peer's
console.
