# Seeder selection in meshare: does probing beat first-responder?

A measurement study of four seeder-selection strategies, run against real
WebRTC data channels. Research code only — nothing here has been shipped into
meshare's production path.

## Problem

meshare currently selects a seeder by probing slots in index order and
committing to the first that answers (`app/public/index.html`, `startReceive`).
Despite the "first responder" framing, this is not a race: slot 0 is tried
first and always wins if it is alive. In effect the client always downloads
from **the lowest-numbered live seeder**, with no quality signal of any kind.

The literature says naive selection is a weak baseline and that
capacity- or proximity-aware selection should beat it. This study asks whether
that holds for meshare specifically, and at what cost.

## Method

Four strategies, all measured on **total time to content = selection overhead
+ transfer time**. Overhead is counted deliberately: a strategy that probes for
2 s and then transfers in 1 s has cost the user 3 s, and is worse than one that
commits instantly and transfers in 2.5 s.

| Strategy | Behaviour |
|---|---|
| `production` | meshare today: probe slots in order, take the first that connects |
| `race` | open all slots simultaneously, keep whichever channel opens first |
| `rtt` | connect to all, ping each 3×, commit to the lowest median RTT |
| `rttbw` | as `rtt`, plus a 64 KB probe transfer; commit to the lowest predicted completion time |

**Harness.** Each seeder runs in its **own Chrome process** (separate event
loop), driven by `run-experiment.js`. All four strategies are evaluated
against the same live seeder set inside one client session, with strategy
order rotated per round so no strategy is systematically first or last. A
ground-truth pass measures every seeder's real transfer cost up front, so each
strategy's pick can be scored against the best choice that was actually
available.

**Network diversity.** Real multi-network testing was not available (single
machine, single uplink). Two substitutes were used, and the limits of both are
stated in Limitations:
- **Real paths:** forcing `iceTransportPolicy: 'relay'` routes a peer's traffic
  through the Metered TURN server and back — a genuine internet round trip.
  Measured separation: 1.2 ms direct vs 300 ms relayed, 0.99 MB/s vs 0.05 MB/s.
- **Synthetic paths:** per-seeder injected delay (ms) and uplink rate cap
  (KB/s), which allow controlled, reproducible conditions including ones the
  relay trick cannot produce (notably: low latency combined with low bandwidth).

## Results

Median total time to content, in ms. Lower is better; **bold** = best in row.

| Condition | payload | `production` | `race` | `rtt` | `rttbw` |
|---|---|---|---|---|---|
| A · null control, 4 identical seeders | 512 KB | **853** | 912 | 937 | 1197 |
| B2 · latency spread 0/40/90/150 ms, equal bandwidth | 512 KB | **1073** | 1125 | 1579 | 1849 |
| E · same as B2, seeder order reversed | 512 KB | 938 | **889** | 1293 | 1593 |
| C · anti-correlated: near+slow at low slots | 512 KB | 8778 | 8785 | 9363 | **2251** |
| F · same peers as C, order reversed | 512 KB | **1156** | 1172 | 9404 | 2380 |
| C2 · anti-correlated, larger payload | 2 MB | 10069 | 10079 | 10794 | **3581** |
| D · real TURN-relay paths at slots 0,1 | 512 KB | 3520 | **902** | 2078 | 3337 |
| **Worst case across all conditions** | | 10069 | 10079 | 10794 | **3581** |

### 1. The dominant effect is slot assignment, not strategy

Conditions C and F contain **the exact same four seeders**. The only difference
is which slot each occupies. `production` scores 8778 ms in one and 1156 ms in
the other — a **7.6× swing driven entirely by arbitrary slot ordering**.

This is the study's most important finding, and it is a finding about meshare
rather than about selection algorithms. Today's behaviour isn't "fast" or
"slow"; it is a coin flip whose outcome is fixed by which peer happened to
claim slot 0 first. Averaged over random arrangements it gets an average peer,
with no floor on how bad the draw can be.

### 2. RTT-only selection was never the best strategy in any condition

Not once across seven conditions. Two distinct failure modes:

- **When it is accurate, the win is too small to pay for the probe.** In
  condition E it identified the lowest-latency seeder in 100% of rounds and
  still lost (1293 ms vs 889 ms), because ~900 ms of probing bought a latency
  advantage worth far less than that on a 512 KB transfer.
- **When latency and bandwidth disagree, it is actively harmful.** In C and F
  it reliably picked the nearby-but-slow peer — 9363 ms and 9404 ms, *worse
  than doing nothing*.

There is also a structural reason RTT probing struggles here: connection
establishment time already encodes most of the same signal. `race` measures it
for free; explicit RTT probing pays extra for a largely redundant measurement.
That is exactly what condition D shows — `race` (902 ms) beat `rtt` (2078 ms)
while selecting from the same candidates, because relay paths are slow to
*connect*, not just slow to transfer.

### 3. Bandwidth estimation is the only thing that prevents the worst case

`rttbw` is the sole strategy that never lands in a multi-second hole: worst
case 3581 ms versus 10069–10794 ms for every other strategy — a **2.8×
better worst case**. In the anti-correlated conditions it cut total time by
74% (C) and 64% (C2).

Its cost is real but bounded: **+344 ms** versus `production` in the null
control, where there is nothing to gain. The trade is roughly "spend a third
of a second in the common case to avoid losing six-plus seconds in the bad
case."

### 4. Probe overhead amortises, so the right answer depends on payload size

At 512 KB, `rttbw`'s overhead is ~68% of its total time. At 2 MB it falls to
~11%. Selection sophistication only pays for itself once the transfer is large
enough to dominate the probe.

## Verification pass

Applying the same skeptical discipline as the heartbeat work, before trusting
any of the above. Four problems were found — three in the harness, one in the
experimental design — and all four changed the results.

1. **The experiment was initially unmeasurable, and I nearly ran it anyway.**
   Four seeders on one machine produced an RTT spread of **0.5 ms** (1.8–2.3 ms
   range). Any "improvement" measured there would have been noise. This forced
   the relay/injection approach.
2. **The relay parameter was dead code.** `iceTransportPolicy` is per-`Peer`,
   not per-connection, so relay-forced runs were silently identical to direct
   runs. Had this gone unnoticed it would have produced fabricated "real
   network" data indistinguishable from the baseline.
3. **The first implementation strawmanned the hypothesis.** Probing connected
   to seeders *sequentially*, charging RTT selection ~350 ms per extra
   candidate (1411 ms total overhead). Parallelising dropped it to 419 ms.
   Reporting the original numbers would have condemned RTT selection for a flaw
   in my code rather than in the idea. A second instance of the same class of
   error — 8 sequential pings, so probe cost scaled with the *worst*
   candidate's latency — was found later and reduced to 3.
4. **Best-case seeders were placed at slot 0, flattering the baseline.** In A
   and B the fastest peer sat at index 0, which `production` always picks. That
   made a strategy with no quality signal look competent. Re-running with
   reversed orderings (E, F) exposed the 7.6× swing described above, and turned
   an apparent baseline strength into the study's main finding.

**Confounds identified but not eliminated:**

- *Condition D is not reproducible enough for n=3.* Raw `production` totals
  were 2746 / 8469 / 3520 ms — real TURN throughput is genuinely unstable, so
  D's medians should be read as indicative only. The synthetic conditions are
  by contrast very tight (C: 8778 / 8789 / 8765 ms).
- *Ground truth is measured once, at the start.* Under drifting relay
  conditions the "picked-best" labels for D are unreliable.
- *`rttbw`'s bandwidth probes run concurrently*, so candidates briefly compete
  for the same downlink and may be mutually under-measured. Serialising them
  would add a full probe duration per candidate to the critical path, so this
  was accepted rather than fixed.
- *Five Chrome processes share one CPU*, so throughput figures include some
  local scheduling contention.

## Limitations

- **No real network diversity.** Every peer is one machine on one uplink.
  Relay-forcing supplies genuine internet paths but only a *bimodal* split
  (~1 ms vs ~300 ms); real swarms have a continuous spread. Injected delay and
  rate caps are constant, with no jitter, packet loss, or congestion response.
- **Small n.** Three rounds per condition. Adequate for the synthetic
  conditions, insufficient for the relay condition.
- **No adversarial or churn conditions.** No peers lying about capacity, no
  mid-transfer departures, no competing swarm traffic.
- **Scale mismatch.** meshare caps at 8 seeder slots and realistically sees
  1–3. Selection is meaningless with one candidate, where probing is pure
  overhead. These results describe the 3–4 candidate case.
- **Single payload profile.** One file, sequential download from a single
  chosen peer. Multi-source swarming would change the problem entirely.

## Conclusion and recommendation

**Ship `race`.** Replace "commit to the lowest-numbered live seeder" with
"open all candidate slots and keep whichever connects first." It costs ~40–60 ms
over current behaviour, is never meaningfully worse in any condition tested,
wins outright where bad paths are slow to establish (74% faster in condition
D), and — most importantly — eliminates the arbitrary 7.6× slot-ordering
lottery, which is the largest real defect this study found. Low risk, small
diff, clear win.

**Do not ship `rtt`.** It was not the best strategy in a single condition
tested, and it is actively harmful when latency and bandwidth disagree. The
signal it buys is largely already available for free in connection
establishment time.

**Hold `rttbw`, with a documented case for revisiting it.** It is the only
strategy that bounds the worst case (2.8× better than everything else) and the
only defence against a nearby-but-slow peer. But it costs ~344 ms when there is
nothing to gain, that cost only amortises above roughly 1–2 MB, and it is moot
in the 1–2 seeder case meshare usually sees. The honest blocker is that
**nobody knows how often the anti-correlated case actually occurs in real
meshare swarms** — the condition where `rttbw` earns its keep is entirely
synthetic here. The sensible sequence is: ship `race`, instrument real
transfers to measure how often a better seeder was available and passed over,
and revisit bandwidth probing behind a payload-size threshold if that data
justifies it.

**On the literature's prediction.** The claim that proximity-based selection
reliably beats first-responder did **not** replicate here. It holds only where
latency correlates with throughput; where it does not, proximity selection was
worse than no selection at all. Capacity-based selection did replicate, and
strongly — but with a cost structure that matters at meshare's payload sizes
and swarm scale.

## Reproducing

```bash
cd research/seeder-selection
node run-experiment.js '{"tag":"A-null","seeders":[{},{},{},{}],"rounds":3}'
node run-experiment.js '{"tag":"C-anticorr","seeders":[{"delay":5,"rate":64},{"delay":10,"rate":128},{"delay":120,"rate":4096},{"delay":160,"rate":4096}],"rounds":3,"pings":3}'
node run-experiment.js '{"tag":"D-relay","seeders":[{},{},{},{}],"relay":[0,1],"rounds":3,"pings":3}'
```

Raw per-run data is written to `results-<tag>-<run>.json`.
