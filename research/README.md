# Research

Measurement studies on meshare's own behaviour. Each study is self-contained:
a harness that can be re-run, the raw per-run data it produced, and a write-up
that reports what was found, including the cases where the expected result did
not appear.

Code in here is **not** part of the meshare product and is not shipped to
users. Where a study led to a production change, the change is noted below and
the relevant production code links back to the findings.

| Study | Question | Outcome |
|---|---|---|
| [seeder-selection](seeder-selection/FINDINGS.md) | Does probing seeders for latency or bandwidth beat taking the first one that answers? | Latency probing never won in any condition tested. Connection-race selection shipped; bandwidth probing documented but held. |
| [gossip-rooms](gossip-rooms/FINDINGS.md) | Can partial-view gossip take live rooms past the 8 peer full-mesh cap without a paid relay? | Verified to 100 peers at 100% delivery with connection count held flat. Not shipped: no demand, and full mesh is better below 8. |
| [crdt-state](crdt-state/FINDINGS.md) | Can hosted sites get automatic shared state across viewers, using CRDTs over the existing mesh? | Convergence verified including real partition healing. No SDK built: documents grow without bound and compaction is not safe peer to peer. |
| [retry-scheduling](retry-scheduling/FINDINGS.md) | Does distance-scaled retry timing (SRM-inspired) stop live-room reconnect storms? | Staggering the wait alone did nothing under the old poll loop; firing on the computed time does. Shipped to `live.html`, verified live with 3 real peers. |
| [ormap-cells](ormap-cells/FINDINGS.md) | Does a dot-based OR-Map fix the CRDT study's unbounded growth for independent key-value cells? | Growth becomes `O(live values)` not `O(writes)`, and is invariant to write order where Yjs swings 274x. Not shipped: meshare's reused seat ids would cause silent, partial data destruction. |

## Method notes that apply to all studies

- **Overhead counts.** Strategies are compared on total time to the user, not
  on how good their pick was in isolation. A better choice that takes longer to
  arrive at is not automatically better.
- **A null control is run first.** If a harness reports a difference between
  strategies when all candidates are identical, the harness is wrong.
- **A skeptical pass is mandatory before publishing a result**, specifically
  looking for reasons a favourable result might be an artefact. Problems found
  this way are written up rather than quietly fixed. See the verification
  section of each study.
- **Known limitations are stated plainly**, including the ones that weaken the
  conclusions.
