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

**4. The first explanation of that failure was wrong, and was corrected later.**

Finding the growth was right. Explaining it was not. The first version of this
study attributed it to CRDT history retention as a general property, which is
the intuitive reading and is what the numbers appear to show if write count is
the only variable examined. Holding write count fixed and varying write *order*
instead produces a 300x swing, which no history-retention account predicts. The
corrected attribution is in "What actually drives the growth" below. The
conclusion this study reached did not change; the reasoning behind it was
wrong, and a reader who accepted the original explanation would have drawn the
wrong lesson about which fixes were worth trying.

## The blocking problem: unbounded growth

Writing repeatedly to a small fixed set of keys does not reuse space. The
document grows linearly and permanently, at roughly 9 bytes per write,
regardless of how few cells are actually live.

| Writes | Live cells | Document size | Bytes per write |
|---|---|---|---|
| 100 | 20 | 925 B | 9.3 |
| 1,000 | 20 | 9,081 B | 9.1 |
| 5,000 | 20 | 45,101 B | 9.0 |
| 20,000 | 20 | 183,719 B | 9.2 |

After 20,000 writes the document holds 20 live cells worth roughly 240 bytes of
actual data, in 183,719 bytes of storage. That is a **438x overhead**, and it
keeps growing. More importantly, **a peer joining late must download all of it**
to see those 20 cells, because history is how the CRDT knows the ordering is
correct.

### What actually drives the growth

**A correction to the first version of this study.** The growth above was
originally attributed to CRDT history retention in general: the claim was that
a CRDT must keep its operation history, therefore the document must grow. That
attribution was wrong, and a follow-up measurement (`measure-growth.js`) shows
what the dominant term really is.

Same 20,000 writes. Same 20 keys. Same final values. **Only the order differs:**

| Write order | Document size |
|---|---|
| Round-robin across 20 keys (what the stress test did) | 183,659 B |
| Grouped: all writes to `s0`, then all to `s1`, ... | **611 B** |
| Round-robin, each round batched into one transaction | 183,619 B |
| 20,000 writes to a single key | 51 B |

**A 300x difference from write ordering alone.** Yjs run-length-merges
consecutive structs belonging to the same client: a stretch of deleted items
collapses into one compact run, but only if those items are *adjacent in that
client's operation log*. Hammering one key produces adjacency, so it collapses
to almost nothing. Round-robin across 20 keys interleaves them, nothing merges,
and every write keeps its own struct at ~9 bytes forever.

Batching each round into a single `doc.transact()` did not help, which rules
out transaction boundaries and confirms the mechanism is struct adjacency.

This is not a `Y.Map` property. `Y.Text` shows exactly the same effect:

| Y.Text operation, 5,000 edits | Document size |
|---|---|
| Append to the end (contiguous) | 5,015 B (1.0 B/char) |
| Insert at position 0 (scattered) | 49,878 B (10.0 B/char) |
| Delete-all and reinsert, repeatedly (contiguous) | 41 B |

So the correct statement is not "CRDTs grow." It is: **Yjs's cost is driven by
how fragmented a client's operation log is, and interleaved writes across
independent keys are the worst case for it.** Study 1's `Y.Map` grid of 20
unrelated cells is precisely that worst case, because a sequence CRDT is being
used for state that has no sequence in it.

**The original conclusion still holds**, and should not be softened: real
shared-state access *is* interleaved. Nobody writes a whiteboard or a game
board one cell at a time to exhaustion. The 611 B figure is a diagnostic that
identifies the mechanism, not an achievable optimisation, because write order
is the application's, not the library's. Growth remains linear and unbounded
for any realistic access pattern. Only the explanation changes, and it changes
in a way that matters: the cost is specific to using a sequence CRDT for
unordered key-value state, not inherent to replicated data types.

### `gc` was already enabled, so it is not the fix

`crdt-peer.html` constructs `new Y.Doc()` with no options. Yjs's own default is
`gc: true`, so the prototype was already garbage collecting throughout. Turning
it off is strictly worse:

| Writes | `gc: true` | `gc: false` |
|---|---|---|
| 1,000 | 9,081 B | 15,831 B |
| 20,000 | 183,719 B | 352,429 B |

GC is buying roughly 2x and is already switched on. There is no configuration
change available that alters the growth class.

**Measurement variance worth recording:** repeated runs of the identical
20,000-write round-robin produce sizes between roughly 163 KB and 184 KB. Yjs
assigns a random `clientID` per document, and that changes how efficiently
identifiers encode. This explains why the first pass of this study reported
183,639 B in one place and 163,657 B in another: those were not two different
measurements of different things, they were the same measurement re-run. The
per-write cost of ~8 to 9 bytes is stable across runs; the absolute total is
not, to about 10%.

For the intended use case this is severe. A shared whiteboard or a game board
updates continuously. At ten writes per second, a thirty minute session
accumulates roughly 165 KB of history to show a screen of current state, and a
long-lived hosted site would grow without limit.

### Compaction exists but is not safe in a peer to peer setting

Rebuilding a document from only its current values shrinks it from 183,659
bytes to 359 bytes, a 511x reduction. Yjs does not do this automatically:
passing the document through a fresh instance returns exactly the same size.

The problem is what happens when a compacted document meets a peer that still
holds the history. Merging the two produced a document of 183,836 bytes, which
is larger than before, not smaller.

**Why, precisely.** The rebuilt document is a new `Y.Doc`, and therefore carries
a **different `clientID`** (confirmed directly in `measure-growth.js`). It is
not a smaller version of the same document. It is a fresh set of operations,
authored by what Yjs considers a different participant, that happen to produce
the same visible values. Merging unions operation sets, so the result is the
old history *plus* a second client's worth of new history.

This generalises past Yjs entirely, and is the real reason the obvious fix
cannot work:

> Merge in a CRDT is a **join** in a semi-lattice. Joins are monotone: the
> result is always at least as large as both inputs. No sequence of merges can
> ever shrink state.

That is not a Yjs limitation. It is the exact property that lets peers converge
in any order, with duplicates, with no coordinator. Compaction cannot be
expressed as a merge, because compaction must go *down* and merge only goes
*up*. Shrinking requires every peer to simultaneously **replace** its state
rather than join it, which means stepping outside the merge protocol
altogether.

Compaction therefore only works if every peer discards its history at the same
moment and adopts the new document together, and any peer that later reconnects
holding the old version reintroduces all of it. Agreeing on that moment across
a set of peers with no coordinator is a distributed consensus problem. meshare
has no mechanism for it, and adding one would mean adding the kind of
coordination point the project exists to avoid.

The formal name for the property that would make discarding safe is **causal
stability**: an operation is causally stable once every peer is known to have
seen it, after which no future concurrent operation can arrive that still needs
it for conflict resolution. Computing it requires each peer to know every other
peer's version vector and take the minimum, which in turn requires agreed
membership: knowing exactly who "everyone" is. In a browser mesh where
participants close tabs without warning, stability stops advancing for the
whole group the moment one peer goes quiet. That membership agreement is the
coordinator-shaped requirement, restated.

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

- **Yjs was never in production meshare.** It exists only in this study's
  prototype (`crdt-peer.html`). `app/public/` contains no Yjs and no shared
  CRDT state of any kind. Live-room chat is a direct broadcast over the data
  channel that appends to the DOM (`live.html`, the `t: 'chat'` branch), with
  no persistence, no set semantics and no delete, so it is not an
  observed-remove set or any other CRDT. The roster is local-only: each peer
  derives it from its own connections and never merges it with anyone. Every
  result in this study describes the prototype, not the shipped product, and
  nothing here should be described as a property of meshare as deployed.
- **Only one CRDT library was tested.** Every growth figure is a property of
  Yjs specifically. The corrected attribution above (struct fragmentation from
  interleaved writes) is a Yjs implementation characteristic. Other designs
  behave differently in kind, not just degree: an optimised observed-remove set
  of the sort in Baquero's `delta-enabled-crdts` stores live data plus an
  `O(peers)` version vector and infers deletions from it, so it has no
  operation history to accumulate and nothing to garbage collect. No such
  alternative was implemented or measured here, so the comparison is drawn from
  reading that reference implementation, not from a benchmark.
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
bytes per write, with a 438x storage overhead in the tested pattern, and the
obvious fix is not safe without a coordination mechanism meshare does not have
and should not want. The corrected attribution does not change that conclusion,
but it does change what the fix would be: the cost comes from using a sequence
CRDT for unordered key-value state, so the first thing to try is not compaction
at all, but a data type that never accumulates history in the first place. A shared-state SDK offered to arbitrary hosted sites would
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
4. Before treating compaction as the open question, try the cheaper thing
   first: replace the `Y.Map` grid with a data type built for unordered
   key-value state, such as an observed-remove map of multi-value registers.
   That approach stores live values plus an `O(peers)` causal context rather
   than an operation log, which would make growth a function of cell count and
   peer count instead of write count. If that holds, compaction stops being
   necessary for this use case rather than remaining blocked on consensus.

   **This was done. See [ormap-cells](../ormap-cells/FINDINGS.md).** The
   premise held: growth becomes a function of live values rather than writes,
   and is invariant to write order where Yjs swings 274x on identical data. It
   is still not shipped, for an unrelated reason found in the process, that
   meshare's seat names are reused across occupants and using them as CRDT
   actor ids causes silent, partial data destruction that still converges. One
   correction to the cost model quoted above: the context is
   `O(actors that have written)`, not `O(peers)`, so a peer that only observes
   is free.
5. Treat compaction as an open research question only for the cases the above
   does not cover, notably real collaborative text, where retaining deleted
   positions is genuinely required to order concurrent inserts correctly.

## Reproducing

Convergence and partition scenarios, which need real peers and signalling:

```bash
cd research/crdt-state
node run-crdt.js
```

Raw per-run data is written to `crdt-results-<room>.json`.

Growth measurements, which are local to a single document and need no network:

```bash
cd research/crdt-state
node measure-growth.js
```

Absolute totals vary by roughly 10% between runs because Yjs assigns a random
`clientID` per document. The per-write cost and the ordering effect are stable.
