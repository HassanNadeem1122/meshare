# Scaling live rooms past 8 peers with partial-view gossip

A measurement study of whether meshare's live rooms can grow beyond the current
8 person full mesh by giving each peer only a handful of connections and
propagating messages hop by hop, rather than by introducing a paid relay
server. Research code only. Nothing here has been shipped into production.

## Problem

meshare's live rooms use a full mesh: every peer holds a direct connection to
every other peer. Connection count grows as O(n squared), and each broadcast
requires the sender to transmit the same message once per recipient. The room
size is capped at 8 for this reason.

The conventional fix in commercial products (Zoom, Discord) is a Selective
Forwarding Unit: a server that receives each message once and fans it out.
That works, but it reintroduces exactly the cost centre meshare exists to
avoid, since the operator pays for all traffic.

## Background

Three pieces of prior work define the alternative.

**HyParView** (Leitao, Pereira, Rodrigues, 2007) maintains a small partial view
of the membership at each node instead of a global view. Each node keeps an
active view of a few peers used for message passing, plus a larger passive view
used to repair the overlay when nodes fail. The key property is that the active
view size stays constant as the system grows, while the overlay remains
connected with high probability.

**Plumtree** (Leitao, Pereira, Rodrigues, 2007) builds on that by splitting
broadcast into eager push along a spanning tree, plus lazy push of message
identifiers along the remaining links, so that the tree can be repaired when it
breaks without paying to flood full payloads continuously.

**GossipSub** (libp2p) is the production example, used by Ethereum's consensus
layer among others. It demonstrates that partial-view gossip carries real
traffic at scale rather than remaining a research construct.

This study implements the HyParView-style partial view and the eager push half
of Plumtree with duplicate suppression. Plumtree's lazy push and tree repair
are not implemented, and the consequence of that omission is measured below.

## Method

**Overlay construction.** Rather than HyParView's randomised views maintained
by periodic shuffling, this prototype uses a deterministic small world graph:
a ring, which guarantees the overlay is connected, plus power of two chords,
which keep the diameter logarithmic rather than linear. This was chosen so that
every run is exactly reproducible. The cost of the simplification is discussed
in Limitations.

**Broadcast.** Eager push flooding. On receiving a message a peer checks a seen
set, drops the message if it is a duplicate, otherwise delivers it locally and
forwards it to every neighbour except the one it arrived from.

**Harness.** `run-gossip.js` starts a local PeerJS signalling server, serves the
prototype, and drives one run in headless Chrome. All peers run inside a single
page so that their clocks are directly comparable. The consequences of that
decision are examined in the verification pass, because they turn out to matter.

**Metrics.** Delivery ratio, hop count, per peer connection count (degree),
total wire messages per broadcast, duplicates suppressed, and wall clock
latency.

## Results

### Scaling of the partial view, k = 4

| Room size | Edges | Degree (median) | Wire messages per broadcast | Duplicates suppressed | Delivery | Hops (median / max) |
|---|---|---|---|---|---|---|
| 10 | 22 | 4 | 35 | 78 | 100% | 2 / 3 |
| 20 | 45 | 5 | 71 | 156 | 100% | 2 / 4 |
| 50 | 112 | 4 | 145 | 300 | 100% | 4 / 8 |
| 100 | 225 | 5 | 351 | 756 | 100% | 7 / 13 |

Per peer connection count stays flat at 4 to 5 across a tenfold increase in
room size, which is the central claim of the partial view approach and it
holds. Hop count grows as expected for a logarithmic diameter overlay: log base
2 of 100 is approximately 6.6, against a measured median of 7.

### Direct comparison against full mesh

| n = 20 | Edges | Degree | Wire messages per broadcast | Hops | Delivery |
|---|---|---|---|---|---|
| Full mesh | 190 | 19 | 361 | 1 | 100% |
| Gossip, k = 4 | 45 | 5 | 71 | 2 to 4 | 100% |

At 20 peers, gossip uses 4.2 times fewer connections and 5.1 times fewer wire
messages, at the cost of 1 to 3 additional hops. Extrapolating the message
counts, at 100 peers full mesh would require roughly 9,900 transmissions per
broadcast against the measured 351 for gossip, a reduction of about 28 times.

### Effect of fanout

| Configuration | Edges | Hops (median / max) | Delivery |
|---|---|---|---|
| n = 100, k = 3 | 150 | 13 / 25 | 100% |
| n = 100, k = 4 | 225 | 7 / 13 | 100% |

Reducing the partial view from 4 to 3 nearly doubles the hop count. Both
deliver reliably, but k = 4 is clearly the better operating point, and k = 3 is
close to the floor for a room of this size.

### Failure tolerance

| Test | Survivors | Delivery to survivors |
|---|---|---|
| 5 of 50 peers destroyed during propagation | 44 | 100% |
| 10 of 50 peers destroyed during propagation | 39 | 100% |

Peers were destroyed 15 ms after the broadcast began, which is inside the
propagation window given that a 50 peer round completes in roughly 8 to 30 ms
in this harness. Delivery to surviving peers remained complete in both cases.

## Verification pass

Applying the required skeptical review before accepting any of the above. Three
findings, two of which materially change how the results must be read.

**1. The wall clock latency figures do not represent real world latency, and
should not be quoted as if they did.**

The suspicion arose from an inconsistency: k = 3 produces 13 median hops while
k = 4 produces 7, yet both measured roughly the same wall clock latency at 100
peers (31 ms against 34 ms). If latency were driven by hop propagation, the
k = 3 configuration should have been substantially slower.

Testing this directly, the correlation between a peer's own hop count and its
receipt time within a single broadcast is 0.966 to 0.995 across three rounds.
The propagation mechanism is therefore real and hop ordering is genuine.
However, the implied cost per hop measured 7.58 ms, 7.0 ms and 3.0 ms in three
consecutive rounds of the *same* configuration. A stable network property would
not vary by a factor of 2.5 between identical runs. The per hop cost in this
harness is dominated by local event loop scheduling and loopback delivery, not
by network transit.

Consequence: hop counts, degrees, delivery ratios and message counts are
trustworthy, because they are topology properties. Absolute latency is not.
Real world latency must be estimated as hops multiplied by a realistic per hop
network cost, stated as an explicit assumption:

| Room size (k = 4) | Median hops | At 30 ms per hop | At 60 ms per hop | At 150 ms per hop (relay heavy) |
|---|---|---|---|---|
| 20 | 2 | 60 ms | 120 ms | 300 ms |
| 50 | 4 | 120 ms | 240 ms | 600 ms |
| 100 | 7 | 210 ms | 420 ms | 1,050 ms |
| 100 (worst placed peer, 13 hops) | 13 | 390 ms | 780 ms | 1,950 ms |

**2. The full mesh comparison could not be extended past 20 peers, for a reason
that does not apply to real users.**

Attempting full mesh at 50 peers failed with a Chrome error: "Failed to
construct 'RTCPeerConnection': Cannot create so many PeerConnections". A 50 peer
full mesh requires 1,225 edges, and because this harness co-locates every peer
in one renderer process, that exceeds Chrome's per process connection ceiling.

This is explicitly an artefact of the test design. A real 50 person full mesh
room places 49 connections in each of 50 separate browsers, which no browser
would refuse. The genuine objection to full mesh is per peer bandwidth and CPU,
which the message count comparison above quantifies, and not this ceiling. The
full mesh figures in this study are therefore limited to 20 peers, and the 100
peer full mesh figure quoted earlier is an extrapolation from the O(n squared)
message pattern rather than a measurement.

**3. The signalling capacity probe produced numbers that must not be read as a
capacity curve.**

Probing the public PeerJS server gave 20 of 20 peers registered, then 27 of 100,
then 0 of 50. The 50 peer result being worse than the 100 peer result shows the
failures are cumulative rate limiting triggered by the probes themselves, not a
per room capacity limit. Two things follow. First, these probes establish only
that a limit exists and that it was reached, not where it lies. Second, and
more importantly, all of the probe load originated from a single IP address,
whereas a real 100 person room would arrive from 100 different addresses. The
public server's behaviour under genuinely distributed load was not measured and
remains unknown.

All scaling results above were therefore produced against a locally hosted
signalling server, so that signalling capacity is removed as a variable and the
topology can be assessed on its own terms.

## Limitations

- **Latency is not measured under real network conditions.** Every peer runs on
  one machine, over loopback, inside one event loop. The projections above are
  arithmetic on measured hop counts, not observations.
- **The membership scheme is not real HyParView.** It is a deterministic small
  world graph with no active or passive views, no shuffling, and no overlay
  repair after failure. Delivery held under the failure tests only because the
  ring plus chord structure retains redundant paths; a genuine implementation
  would need HyParView's repair mechanism for sustained churn, which was not
  built or tested.
- **Plumtree's lazy push is not implemented.** The duplicate counts show the
  price: at 100 peers, 756 of 1,107 received messages were duplicates, about
  68 percent. Eager push flooding is simple and reliable but wasteful, and this
  is precisely the inefficiency Plumtree's tree optimisation exists to remove.
- **Sustained churn was not tested.** Peers were destroyed once, mid
  propagation. Continuous join and leave traffic, which is the realistic
  condition for a chat room, was not simulated.
- **No adversarial behaviour was tested.** No peers dropping messages
  selectively, lying about membership, or flooding.
- **Text and presence only.** Audio and video are out of scope, and multi hop
  gossip is the wrong structure for them.

## Conclusion

The technical question has a clear answer. A partial view of 4 connections per
peer sustains complete delivery at 100 peers, which is 12.5 times meshare's
current cap, while holding per peer connection count flat and reducing
broadcast traffic by roughly 28 times against full mesh. Estimated propagation
for a 100 person room falls between 210 ms and 1,050 ms depending on per hop
network cost, which is acceptable for text chat and presence, where anything
under about a second is unobtrusive.

On infrastructure cost, the central claim survives with one qualification. The
gossip topology itself requires no relay server, so the SFU cost centre is
genuinely avoided. However, signalling remains a mandatory coordination point:
every peer must register and every one of the roughly 2n connections must be
brokered. meshare currently depends on the free public PeerJS server, which
already carries no uptime guarantee, and which is the component most likely to
fail first as rooms grow. TURN relaying for strict NAT peers also remains
necessary and is metered at volume. The honest formulation is that gossip
removes the per message relay cost, not that it removes all infrastructure.

## Recommendation: do not ship this yet

The prototype works and the scaling claim is verified, but shipping it now would
be solving a problem meshare does not have.

1. **There is no demand.** Live rooms are positioned as disposable rooms for
   small groups. No user has asked for a room larger than 8. Replacing a working
   implementation on the strength of a hypothetical requirement inverts the
   correct order.
2. **Full mesh is better in the range meshare actually operates in.** At 8
   peers or fewer, full mesh delivers in a single hop with no forwarding logic,
   no duplicate suppression, and no partition concerns. Gossip would make small
   rooms slightly slower and considerably more complex.
3. **The binding constraint is elsewhere.** Signalling, not topology, is what
   fails first at scale, and this change does not address it.
4. **The maintenance cost is real.** Partial view repair under churn, duplicate
   suppression state, and partition handling are ongoing obligations, and the
   failure modes are harder to reason about than a full mesh.

The recommendation is to retain this as documented research and revisit it if
demand for larger rooms appears. If it is revisited, the natural design is a
hybrid: keep full mesh at 8 peers or fewer, and switch to partial view gossip
above that threshold, so that the common case stays simple and only large rooms
pay the complexity. That hybrid is worth building on evidence of need, and not
before.

## Reproducing

```bash
cd research/gossip-rooms
node run-gossip.js "n=100&k=4&mode=gossip&msgs=3&tag=demo"
node run-gossip.js "n=20&k=4&mode=mesh&msgs=3&tag=meshbase"
node run-gossip.js "n=50&k=4&mode=gossip&msgs=3&tag=kill&kill=3,8,14,19,25&killMid=1"
```

Raw per run data is written to `gossip-<tag>-n<size>-<mode>.json`.
