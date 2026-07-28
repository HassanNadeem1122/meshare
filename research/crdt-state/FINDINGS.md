# Automatic shared state for hosted sites, using CRDTs over meshare's mesh

An exploratory study of whether a generic shared-state layer can be added to
meshare's P2P mesh, so that a hosted site (a shared whiteboard, a simple
multiplayer board) gets live consistent state across all viewers without the
site author writing any networking code. Research code only. Nothing here has
been shipped, and no SDK has been built.

## Problem

meshare hosts static site bundles peer to peer. Every visitor receives byte
identical files, and nothing is shared between them afterwards. Study 2 showed
that broadcasting messages across a mesh works, but broadcast alone is not
shared state. The moment two people change the same thing at nearly the same
moment, something has to decide what the result is, and every peer has to reach
the same answer independently, with no server to arbitrate.

That is the problem Conflict-free Replicated Data Types exist to solve. This
study asks whether wiring one to meshare's existing peer connections produces
genuinely correct shared state for one real test case.

## Stage 1: the test case

Deliberately minimal, but chosen so that it exercises real conflict rather than
appending to a log, which is trivially conflict free:

- **A shared grid** (`Y.Map` of cell to value). Tests concurrent writes to the
  same key, where exactly one value must win and every peer must agree on which.
- **A shared text line** (`Y.Text`). Tests concurrent insertion at the same
  position, which is the case naive approaches garble.

A full multiplayer game was explicitly not attempted.

## Stage 2: what was built

`crdt-peer.html` is one peer. It holds its own `Y.Doc` and connects to the other
peers over meshare's existing PeerJS DataConnections. The Yjs provider is
written from scratch rather than using `y-webrtc`, because the point was to
reuse the peer discovery meshare already has instead of introducing a second
signalling stack.

The sync protocol is the standard Yjs handshake. On connect, each side sends its
state vector, which is a compact summary of what it already knows. The other
side replies with exactly the operations the first side is missing. After that,
local changes are encoded as updates and pushed to every connected peer.

**Each peer runs in its own browser process.** This was not for realism but for
correctness of the experiment: if every peer shared one JavaScript context, a
bug that let two peers touch the same object would produce perfect convergence
that meant nothing. Separate processes make that class of false positive
impossible.

## Stage 3 and 4: results and verification

Three peers, real WebRTC connections, plus a fourth joining late.

| Scenario | Result |
|---|---|
| A. Sequential edits from each peer | Converged, identical state vectors |
| B. All three peers write the SAME key simultaneously | Converged, all agreed on one winner |
| C. All three insert text at the same position | Converged, all agreed on one ordering |
| D. Peer partitioned, conflicting edits on both sides, then healed | Diverged while split, converged on heal, identical state vectors |
| E. Fourth peer joins after all the above | Received full history, converged with the rest |
| F. Propagation latency, peer 0 to peer 1 | 1 ms median in-page |
| G. 300 concurrent writes across 3 peers onto 20 shared keys | Converged, identical state vectors |

Convergence was checked two ways, not one. Comparing the visible grid and text
is not sufficient, because two peers can display identical content while holding
different underlying documents. Every scenario therefore also compares the Yjs
state vector, which is a fingerprint of the document itself. All scenarios above
matched on both.

The winner in scenario B and the ordering in scenario C changed between runs
(`from-peer-1`, then `from-peer-2`, then `from-peer-0`). That is correct
behaviour rather than a defect. A CRDT guarantees that everyone agrees, not that
the outcome is predictable in advance, because ties are broken by client
identifiers that are randomly assigned per document.

### Verification pass

**1. The first partition test was invalid, and it reported success.**

Scenario D initially reported that the two sides never diverged while
partitioned, which was recorded as a pass. It was not a pass, it was proof the
test had not worked: if the two sides never disagreed, no partition occurred.
The cause was in the prototype. `connectAll()` runs on a two second retry timer
to pick up late joiners, and it did not check the partition flag, so the
simulated partition healed itself roughly two seconds after being created,
before the conflicting edits were made.

Both were fixed. The retry now honours the flag, and the scenario now asserts
the partition is real before believing anything it reports: it checks that the
isolated peer holds zero connections, and that the two sides genuinely show
different values while split. Only then is the heal meaningful. The corrected
run shows `isolated peer conns=0`, the isolated peer seeing
`written-while-offline` while the majority sees `written-by-majority`, and full
convergence after reconnection.

Had this not been checked, the study would have claimed verified partition
tolerance on the strength of a test that never partitioned anything.

**2. The first latency figure was mostly measuring the test harness.**

Latency was initially measured from the orchestrator: send a command to peer 0,
poll peer 1 until it reacts. That produced a 9 ms median. Adding wall-clock
stamps inside the pages themselves, so that the measurement is taken from the
moment of the edit to the moment the update is applied, gives a 1 ms median.
Roughly 8 ms of the original figure was the orchestrator's own round trip.

Both numbers are reported, and neither should be read as a real world latency.
All peers are on one machine communicating over loopback. Real propagation would
be bounded by network round trip time between actual peers, which the seeder
study measured at 1 to 2 ms on the local path and 147 to 300 ms through a relay.
The honest statement is that the CRDT layer adds close to no overhead of its
own, and that real latency will be whatever the network costs.

**3. The failure that matters was found by following an anomaly in the data.**

The document grew from 367 bytes to 3,118 bytes after the stress scenario. That
prompted a direct measurement of growth, which produced the central negative
result of this study, below.

## The blocking problem: unbounded growth

Writing repeatedly to a small fixed set of keys does not reuse space. The
document grows linearly and permanently, at roughly 9 bytes per write,
regardless of how few cells are actually live.

| Writes | Live cells | Document size | Bytes per write |
|---|---|---|---|
| 100 | 20 | 927 B | 9.3 |
| 1,000 | 20 | 9,001 B | 9.0 |
| 5,000 | 20 | 45,021 B | 9.0 |
| 20,000 | 20 | 183,639 B | 9.2 |

After 20,000 writes the document holds 20 live cells worth roughly 240 bytes of
actual data, in 183,639 bytes of storage. That is a **765x overhead**, and it
keeps growing. More importantly, **a peer joining late must download all of it**
to see those 20 cells, because history is how the CRDT knows the ordering is
correct.

For the intended use case this is severe. A shared whiteboard or a game board
updates continuously. At ten writes per second, a thirty minute session
accumulates roughly 165 KB of history to show a screen of current state, and a
long-lived hosted site would grow without limit.

### Compaction exists but is not safe in a peer to peer setting

Rebuilding a document from only its current values shrinks it from 163,657 bytes
to 339 bytes, a 483x reduction. Yjs does not do this automatically: passing the
document through a fresh instance returns exactly the same size.

The problem is what happens when a compacted document meets a peer that still
holds the history. Merging the two produced a document of 163,834 bytes, which
is larger than before, not smaller. The compacted copy does not replace history,
it simply adds more operations on top of it. Compaction therefore only works if
every peer discards its history at the same moment and adopts the new document
together, and any peer that later reconnects holding the old version
reintroduces all of it.

Agreeing on that moment across a set of peers with no coordinator is a
distributed consensus problem. meshare has no mechanism for it, and adding one
would mean adding the kind of coordination point the project exists to avoid.

## Other costs

- **Bundle size.** Yjs bundles to 91.5 KB minified. Every hosted site using this
  layer carries that, against meshare's current site bundle limit of 20 MB but
  also against its positioning as a tool for small, quick sites.
- **Full mesh assumption.** This prototype connects every peer to every other
  peer, which is fine at three or four but inherits exactly the scaling ceiling
  Study 2 examined. Combining CRDT state with partial view gossip was not
  attempted and is not a trivial composition, because gossip may deliver updates
  more than once and out of order, which CRDTs tolerate, but the sync handshake
  assumes a direct link to a specific peer.

## Limitations

- One machine, loopback only. No real network conditions, no packet loss, no
  genuinely distant peers.
- Three to four peers. Nothing was tested at the scale Study 2 examined.
- Short sessions. Nothing ran long enough to observe growth in situ, so the
  growth figures come from a direct measurement rather than from the live
  prototype.
- No adversarial behaviour. No peer sending malformed updates, replaying old
  ones, or deliberately corrupting shared state. In a system where any visitor
  can push updates into everyone's document, that is a real and unexamined risk.
- Only two data types tested, `Y.Map` and `Y.Text`. Arrays, nested structures
  and rich text were not exercised.
- No persistence. Nothing was stored, so recovery after every peer leaves was
  not considered.

## Recommendation

**The correctness question has a clear positive answer. The productisation
question does not, and a general SDK should not be built yet.**

What genuinely works, verified rather than assumed: concurrent writes to the
same key converge with every peer agreeing on the same winner. Concurrent text
insertion converges on the same ordering. A genuinely partitioned peer making
conflicting offline edits reconciles correctly on reconnect. A late joiner
receives full history rather than only future changes. Three hundred concurrent
writes across three peers onto overlapping keys converge to identical state
vectors. The CRDT layer itself adds close to no latency.

What blocks generalisation is that the document grows forever, at roughly 9
bytes per write, with a 765x storage overhead in the tested pattern, and the
obvious fix is not safe without a coordination mechanism meshare does not have
and should not want. A shared-state SDK offered to arbitrary hosted sites would
work impressively in a demo and degrade steadily in real use, with the cost
falling hardest on the newest visitor, who must download the entire history
before seeing anything.

The narrower version that does fit is **ephemeral session state**. meshare's live
rooms already vanish when the last participant leaves, which bounds a document's
lifetime to a single session and makes unbounded growth a non-issue rather than
a design flaw. A shared whiteboard or board game attached to a live room, which
disappears with the room, sits inside what this study verified.

Recommended sequence, if this is taken further:

1. Do not build a general SDK for hosted sites.
2. If a shared-state feature is wanted, scope it to live rooms, where the
   ephemeral lifetime already solves the growth problem.
3. Before shipping even that, test what this study did not: real network
   conditions rather than loopback, more than four peers, sessions long enough
   for growth to be observed in situ, and malicious updates from untrusted
   visitors.
4. Treat compaction as an open research question rather than an implementation
   detail. It is the thing standing between this prototype and a general
   feature.

## Reproducing

```bash
cd research/crdt-state
node run-crdt.js
```

Raw per-run data is written to `crdt-results-<room>.json`.
