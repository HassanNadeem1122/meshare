# An OR-Map of multi-value registers for meshare's independent cells

A measurement study of whether replacing a sequence CRDT with a dot-based
observed-remove map fixes the unbounded growth found in
[crdt-state](../crdt-state/FINDINGS.md). Research code only. Nothing here has
been shipped, and one blocking prerequisite is identified below that must be
solved before it could be.

## Problem

The CRDT study measured meshare's Yjs prototype growing at roughly 9 bytes per
write, forever, while holding 20 live cells worth about 240 bytes. Its
corrected attribution was that the cost comes from using a **sequence** CRDT
for state that has no sequence in it: `Y.Map` of 20 unrelated cells is
`O(writes)` because Yjs retains an operation log, and interleaved writes across
independent keys defeat the run-length merging that would otherwise compress
it.

That study's recommendation was to try a data type that never accumulates
history in the first place, before treating compaction as the open problem.
This study does that. The reference is Carlos Baquero's
[delta-enabled-crdts](https://github.com/CBaquero/delta-enabled-crdts), whose
`ormap` and `mvreg` store live values plus a single shared causal context and
infer removals from it, rather than keeping tombstones or an operation log.

The question: does that shape actually hold up when ported and measured, and
what does it cost instead?

## What was built

Four types ported from the C++ reference to plain JS in `ormap.js`, with no
network, no timers and no browser, so a fake workload drives exactly the code
path a real integration would. Same standalone-testable pattern as
`heartbeat-detector.js` and `retry-scheduler.js`.

| Type | Role |
|---|---|
| `DotContext` | version vector plus a dot cloud for out-of-order dots; `compact()` drains the cloud |
| `DotKernel` | live dot to value map; join infers removals from the other side's context |
| `MVReg` | multi-value register; a write removes the dots it has observed and adds one |
| `ORMap` | keys to registers, all sharing **one** causal context |

The rule the whole structure rests on, in `DotKernel.join`:

> a dot the other side's context **knows** about but does not **hold** is a dot
> the other side deliberately removed.

That is what replaces tombstones, and it is why removal information compresses
into an `O(actors)` version vector instead of an `O(operations)` log.

`ormap-encode.js` is a binary wire format using the same two techniques Yjs
uses, LEB128 varints and an id table referenced by index, left uncompressed to
match. This exists so the size comparison is defensible rather than flattering:
measuring this structure as JSON against Yjs's binary encoding would have
inflated the gap for reasons unrelated to the data model.

## Results

### The headline, and why it is the wrong way to state it

Identical workload, both structures driven from one generated write sequence in
a single process so "identical" is enforced by construction rather than by two
harnesses that are meant to match. One actor, 20 cells, round-robin:

| writes | Yjs | ORMap | ratio |
|---|---|---|---|
| 100 | 1,007 B | 247 B | 4.1x |
| 1,000 | 9,081 B | 288 B | 31.5x |
| 5,000 | 45,101 B | 308 B | 146.4x |
| 20,000 | 183,719 B | 349 B | **526x** |

Quoting 526x on its own would be cherry-picking, because it is measured at
Yjs's worst access pattern. Holding the data identical and varying **only the
write order**:

| order | Yjs | ORMap |
|---|---|---|
| round-robin across 20 keys | 183,719 B | 349 B |
| grouped by key | 671 B | 293 B |
| **swing** | **274x** | **1.19x** |

So the honest claim is not a multiplier:

> **ORMap has no bad case.** Yjs ranges from 671 B to 183,719 B on identical
> data depending purely on the order the writes arrive in. ORMap sits near
> 300 B either way.

That matters more than the ratio, because an application does not control its
own write order. A shared board updated by users produces interleaving, not
grouping, and the study cannot promise which end of Yjs's 274x range a real
deployment lands on.

### One model explains every number

Both structures cost roughly 9 to 10 bytes per item they store. They differ in
**what counts as an item**:

- Yjs stores every **write**, unless consecutive writes happen to be adjacent
  in that client's struct list, in which case they run-length merge.
- ORMap stores every **live value**, always, regardless of order.

So the advantage is approximately `total writes / live values`, and every
result below follows from it. Holding writes at 20,000 and raising the cell
count until nothing is ever overwritten:

| cells | writes/cell | Yjs | ORMap | ratio |
|---|---|---|---|---|
| 20 | 1,000 | 183,719 B | 349 B | 526x |
| 100 | 200 | 184,599 B | 1,709 B | 108x |
| 1,000 | 20 | 195,399 B | 17,910 B | 10.9x |
| 5,000 | 4 | 248,782 B | 92,527 B | 2.7x |
| 20,000 | 1 | 457,791 B | 361,291 B | **1.3x** |

**The advantage is proportional to the overwrite ratio, and correctly vanishes
without one.** With one write per cell every write *is* live data, so there is
no history to avoid storing. meshare's 20-cell case sits at the extreme
favourable end of this curve, which should be stated whenever the 526x figure
is.

### The cost this structure pays: actors, not writes

Held at 20 cells and 6,000 total writes so only the actor count varies. Every
actor walks its own key cycle, so all of them touch all 20 keys:

| actors | Yjs | ORMap | context entries | live dots |
|---|---|---|---|---|
| 1 | 54,121 B | 328 B | 1 | 20 |
| 3 | 53,999 B | 796 B | 3 | 60 |
| 8 | 53,674 B | 1,806 B | 8 | 160 |
| 32 | 51,748 B | 7,382 B | 32 | 640 |
| 128 | 57,952 B | 25,180 B | 128 | 2,560 |
| 256 | 68,966 B | 53,340 B | 256 | 5,120 |
| 512 | 70,157 B | 61,572 B | 512 | ~5,600 |

Yjs is flat in actor count; ORMap is linear. **No crossover occurs in the range
tested**, but the advantage erodes from 165x at one actor to about 1.14x at
512. The reason it never crosses is an artefact of holding total writes fixed:
live values can never exceed total writes, so ORMap's storage is capped by the
same budget Yjs is paying. With more writes per actor the curves would separate
again.

The dominant term is **live dots, which is actors times cells**, not the
context itself. At 128 actors the version vector is 128 entries; the 25 KB is
almost entirely unresolved concurrent values.

At meshare's live-room scale, a maximum of 8 seats, this is about 1.8 KB. That
is fine. For a long-lived hosted site it is the same wall the CRDT study hit,
moved further back rather than removed.

### Multi-value conflicts are a product decision, not an implementation detail

Three actors writing concurrently to 20 cells, then merging all-to-all:

| writes | Yjs | ORMap | ratio | live dots | converged |
|---|---|---|---|---|---|
| 1,000 | 8,979 B | 736 B | 12.2x | 60 | all 3 agree |
| 20,000 | 180,019 B | 856 B | 210.3x | 60 | all 3 agree |

**60 live dots, not 20: three concurrent values in every single cell.** This is
correct rather than a leak. No replica observed any other's writes before the
merge, so each actor's final write per key removed only its own dot. All three
replicas agree, which is asserted in the harness rather than assumed.

But it is a real cost that lands on the product, not on the library. `MVReg.read()`
returns an array, and `readOne()` **throws** on conflict rather than silently
picking a winner. Yjs hid this by choosing one. This surfaces it, which is more
honest and more work: meshare would need a per-cell resolution policy, and a
user interface answer for a cell that legitimately holds several values at
once. A whiteboard might merge them; a game board probably cannot.

The 60-dot case is a worst case produced by a total partition for the whole
write phase. Continuous sync makes it rare. It cannot be assumed away.

## The blocking prerequisite: actor-id reuse

This is the finding that stops the structure shipping as-is, and it comes from
meshare's own architecture rather than from the CRDT.

`claimSeat()` in `app/public/live.html` hands out the lowest free seat. **A seat
is a slot, not a person.** When someone leaves seat 0, the next joiner takes
seat 0. If the seat name were used as the CRDT actor id, two unrelated people
would mint dots from the same lineage, the second restarting at counter 1 on
dots the first already used and that other replicas still hold.

### The failure mode

Alice takes seat 0, writes `x`, syncs with Carol, and leaves. Bob claims the
freed seat with a fresh document, so his counter restarts at 1:

```
alice dot for x: seat0:1
bob   dot for y: seat0:1     <- collision

carol after joining bob   = {}
bob   after joining carol  = {}
agree? true
```

Both values are destroyed. Carol deletes `x` because Bob's context knows
`seat0:1` and he does not hold it there. Carol refuses to import `y` because
her own context already knows `seat0:1`. The destruction is symmetric.

**And the replicas agree.** Snapshots match, so every convergence check, state
vector comparison and consistency assertion still passes. This is silent data
loss that looks completely healthy, which is strictly worse than the growth
problem it was meant to solve: unbounded growth announces itself, this does not.

The damage is also **partial, in proportion to how far the counter ranges
overlap**, which is harder to operate than total loss because the document
still looks populated:

```
first  wrote a,b,c  -> seat0:1, seat0:2, seat0:3
second wrote d,e    -> seat0:1, seat0:2
witness after join  -> {"c":"3"}
```

`a` and `b` die where the ranges collide. `c` survives only because the second
occupant never minted a third dot. Nothing from the second occupant arrives at
all.

### The fix

Actor ids must be unique **per session**, not per seat. A per-session nonce is
enough and keeps the seat readable for logs and routing:

```
seat0-a3f9      not      seat0
```

Verified across 25 successive occupants of a single recycled seat: every
occupant's contribution is retained.

### A runtime detector, and its blind spot

In a correct ORMap a dot is minted exactly once, so it can only ever appear
under one key with one value. The same dot carrying different content is
therefore **proof** of id reuse rather than a heuristic, and a real integration
could refuse such a delta instead of corrupting itself:

```
conflict: seat0:1  held "x=alice-value"  incoming "y=bob-value"
```

Caught before the join, with no false positive on a well-behaved peer.

**The blind spot is tested explicitly and is real.** If the reusing peer has
already overwritten its own value, the colliding dot exists only in its causal
context with no value to compare against. The detector reports nothing, and the
other peer's data is destroyed anyway:

```
bob.set('y','first')    // mints seat0:1
bob.set('y','second')   // mints seat0:2, REMOVES seat0:1
detectReuse(carol, bob) // []  <- sees nothing
carol.join(bob)         // alice's x destroyed regardless
```

So detection is a safety net with a hole in it. Prevention is the actual fix.

## Verification pass

Following the same discipline as the other studies: the mistakes found while
checking are written up rather than quietly corrected, because several of them
changed a reported result.

**1. A clean first run was not trusted, and mutation testing justified that.**

All 14 unit tests passed on the first run, which for subtle CRDT code is a
smell rather than a reassurance. The context-restore line was removed from
`ORMap.join` and the suite re-run. Four tests failed, including commutativity,
and the symptom was exactly the predicted one:

```
MUTANT (no restore) a = {"k1":"b-1"}
FIXED  (restore)    a = {"k1":"b-1","k2":"b-2"}
```

`k2` vanishes because joining `k1` first leaks the other replica's whole
context into the shared one, after which every later key treats the other
side's dots as already seen and refuses to import them. Silent data loss whose
outcome depends on key iteration order, and it breaks commutativity, so without
that single line the structure is not a CRDT at all. This is the subtlest part
of the port, taken from the reference at `delta-crdts.cc:1441`.

**2. The null control was mutation tested too, and it can fail.**

`DotKernel.removeAll` was broken so that it stops clearing old dots. The
control caught it on two independent measures:

```
FAIL: 20000 writes left 20000 live dots, expected 20 - old dots are being retained
FAIL: bytes grew 269.67x against a 200x increase in writes - that is not flat
ORMap: 212,500 bytes   (0.9x - worse than Yjs)
```

That is the specific bug the control exists to catch: silently rebuilding the
operation log the whole structure exists to avoid.

**3. The residual byte creep was decomposed rather than waved through.**

The null control's size moved from 238 B to 340 B across a 200x increase in
writes, which is not perfectly flat. Holding value length fixed isolates it:
318 B to 360 B, which is 42 bytes, exactly 20 dots times about 2 extra varint
bytes as counters cross from one-byte to three-byte encoding. The remainder was
`'a-99'` becoming `'a-19999'`. Fully accounted for, with no residual linear
term.

**4. An actor-count curve was reported non-monotonic, and it was a harness bug.**

The first run of the actor sweep showed 8 actors producing *fewer* bytes than 3,
which no model predicts. The cause was the workload generator: using `i % n` for
the actor and `i % 20` for the key aliases whenever `gcd(n, 20) > 1`, so at 8
actors each one only ever touched 5 of the 20 keys. Not a property of the
structure. Each actor now walks its own key cycle. The table above is the
corrected run.

**5. Two adversarial assertions were wrong, and being wrong sharpened the finding.**

The first draft asserted that actor-id reuse causes *total* annihilation, which
is what the single-key case shows. The test failed: `{"c":"3"}` survived.
Investigating gave the more precise and more alarming result now reported,
that damage is proportional to counter-range overlap, so a corrupted document
stays partly populated and is harder to notice.

The second draft asserted 26 context entries across 25 recycled sessions. It is
25. A replica that never writes never calls `makedot`, so its own id never
enters the context. This is a small correction to the cost model stated
elsewhere: the context is `O(actors that have written)`, not `O(peers ever
joined)`. **A silent observer is free.**

## What is solved and what is open

**Solved, and verified rather than assumed:**

- The port satisfies the semi-lattice laws: join is commutative, idempotent and
  associative. Those three are what "converges without a coordinator" means,
  and they are tested directly rather than inferred from a convergence demo.
- Growth is `O(live values)`, not `O(writes)`. The null control holds live
  dots, context entries and dot cloud size flat across a 200x increase in
  writes, on encoding-independent counts that cannot be flattered by a
  favourable serialisation.
- The unbounded-growth problem from the CRDT study does not exist in this
  structure for the independent-cells case. Compaction is not needed, because
  there is no history to compact.
- Removals survive meeting a stale replica, concurrent writes beat concurrent
  erases, and a late joiner receives current state correctly.
- Actor-id reuse has a working prevention, verified across 25 recycled sessions.

**Open, and blocking:**

- **The detector's blind spot is not acceptable as the only mitigation, and a
  second one is needed before shipping.** Per-session nonces prevent reuse
  provided every peer generates its id correctly. The detector cannot catch a
  peer that gets it wrong once the colliding dot has already been overwritten,
  and the failure is silent. At minimum this needs either a nonce whose
  collision probability is argued explicitly rather than assumed, or a join-time
  guard that rejects a peer whose context claims dots in a range the local
  replica attributes to a different session. Neither is built or measured.
- **The multi-value resolution policy is unanswered.** Three concurrent actors
  produced three values in every cell. `readOne()` throwing is the right default
  for a library but is not a product answer. What meshare shows a user for a
  cell holding several values is a design decision nobody has made.

**Open, but not blocking:**

- The `O(actors that have written)` cost is bounded and small for live rooms,
  and unbounded for long-lived hosted sites. That is the same conclusion the
  CRDT study reached, and it reinforces scoping shared state to ephemeral rooms
  rather than changing it.
- Delta propagation is implemented in the types, every mutation returns a
  delta, but is untested over a real transport.

## Limitations

- **Nothing was integrated into meshare.** This is a standalone port measured
  in isolation. No PeerJS transport, no live rooms, no browser. The claim that
  it fits meshare's mesh better than Yjs's state-vector handshake, because
  joins are idempotent and tolerate duplicate delivery, is reasoning from the
  code and is unverified.
- **Single process, no network.** Every result is a local property of the data
  structure. No packet loss, no partition healing over real connections, none
  of the scenarios the CRDT study ran against real WebRTC peers.
- **Only the workload from the CRDT study was used.** Round-robin and grouped
  writes over string values of similar length. Nothing tested nested values,
  large payloads, or churn during writing rather than before merging.
- **Both structures were measured uncompressed.** Real transports may apply
  compression, which would not affect the two equally: Yjs's operation log is
  highly repetitive and would likely compress better than live values do.
  **This could materially narrow the gap and was not measured.**
- **The `MVReg` `resolve()` operation from the reference was not ported**, so
  the study never exercised value-lattice-based conflict reduction.
- Byte figures for Yjs vary about 10% between runs because Yjs assigns a random
  `clientID` per document. The ORMap figures are deterministic.

## Recommendation

**The structural question has a clear positive answer. Do not ship it yet.**

The premise the CRDT study proposed testing holds: for independent, unordered
key-value cells, a dot-based OR-Map stores live values plus an `O(actors)`
context and simply does not have the growth problem that motivated the whole
investigation. The 526x figure at meshare's own access pattern is real, and the
more durable finding is the 274x versus 1.19x invariance, since an application
cannot choose its write order.

What stops it shipping is not the CRDT. It is that meshare's seat names are
slots rather than identities, and using them as actor ids causes silent,
partial, mutually-agreed data destruction. The fix is small and verified, but
the detector that would catch a mistaken implementation has a proven blind
spot, and no second mitigation exists.

Recommended sequence:

1. Do not use seat names as actor ids anywhere, under any circumstances. Treat
   this as a correctness invariant, not a style preference.
2. Design and measure a second mitigation for the detector's blind spot before
   any integration, since the failure it misses is silent.
3. Decide the multi-value resolution policy as a product question first. It
   determines the API, and retrofitting it later would change every call site.
4. Only then integrate behind the existing live-room scope, where the
   `O(actors)` cost is bounded by the 8-seat cap and the ephemeral room
   lifetime.
5. Measure compressed sizes before repeating any ratio publicly.

## Reproducing

```bash
cd research/ormap-cells
node --test ormap.test.js                    # 14 tests: semi-lattice laws, ORMap semantics
node --test adversarial-actor-reuse.test.js  # 6 tests: the seat-reuse hazard and its fix
node null-control.js                         # flat-growth control, exits non-zero on failure
node head-to-head.js                         # Yjs comparison, conditions A through E
```

`head-to-head.js` reads `../crdt-state/yjs-bundle.js`, so the comparison runs
against the same Yjs build the original study measured.
