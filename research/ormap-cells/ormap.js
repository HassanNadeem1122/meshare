// A JS port of the dot-based CRDT core from Carlos Baquero's
// delta-enabled-crdts (github.com/CBaquero/delta-enabled-crdts): DotContext,
// DotKernel, MVReg and ORMap.
//
// WHY THIS EXISTS: research/crdt-state/FINDINGS.md measured meshare's Yjs
// prototype growing at ~9 bytes per write forever, because a sequence CRDT was
// being used for 20 independent, unordered key-value cells. This structure is
// the alternative that study recommends trying before treating compaction as
// the open problem: it stores live values plus one shared causal context, so
// its size should be a function of cell count and actor count, NOT write count.
//
// THE CENTRAL IDEA. A "dot" is a unique stamp (actorId, counter) minted per
// write. The kernel keeps only LIVE dots. Removals are not stored as
// tombstones; they are inferred at join time from a single rule:
//
//     a dot the other side's context KNOWS about, but does not HOLD,
//     is a dot the other side deliberately removed.
//
// That is what lets removal information compress into an O(actors) version
// vector instead of an O(operations) log. It is the whole reason this shape
// has no unbounded-growth problem to garbage collect.
//
// Pure logic: no timers, no network, no browser. Same testability pattern as
// heartbeat-detector.js and retry-scheduler.js, so a fake workload can drive
// exactly the code path a real integration would.

const SEP = ':';

const fmtDot = (actor, counter) => actor + SEP + counter;
function parseDot(dot) {
  const i = dot.indexOf(SEP);
  return { actor: dot.slice(0, i), counter: Number(dot.slice(i + 1)) };
}

// ---------------------------------------------------------------------------
// DotContext: the compact record of every dot this replica has ever seen.
//
// cc  - "compact causal context": actor -> highest CONTIGUOUS counter seen.
//       This is an ordinary version vector and is the part that stays O(actors).
// dc  - "dot cloud": dots seen out of order, which cannot be folded into cc
//       yet because there is a gap. Transient. compact() drains it.
// ---------------------------------------------------------------------------
class DotContext {
  constructor() {
    this.cc = new Map(); // actor -> counter
    this.dc = new Set(); // dot strings
  }

  // Deep copy. Needed because ORMap.join has to snapshot and restore the
  // shared context between per-key joins; see the comment there.
  clone() {
    const o = new DotContext();
    o.cc = new Map(this.cc);
    o.dc = new Set(this.dc);
    return o;
  }

  // In-place restore. The context is shared BY REFERENCE with every embedded
  // register, so a snapshot cannot be restored by rebinding the variable - the
  // registers would still point at the old object. It has to be mutated.
  copyFrom(other) {
    this.cc = new Map(other.cc);
    this.dc = new Set(other.dc);
    return this;
  }

  dotin(dot) {
    const { actor, counter } = parseDot(dot);
    const seen = this.cc.get(actor);
    if (seen !== undefined && counter <= seen) return true;
    return this.dc.has(dot);
  }

  // Fold dot-cloud entries into the version vector wherever they are
  // contiguous, and drop any that are already dominated by it. Repeats until
  // no progress, because dots can arrive in an order that only becomes
  // compactable after an earlier one is folded in.
  compact() {
    let progress = true;
    while (progress) {
      progress = false;
      for (const dot of [...this.dc]) {
        const { actor, counter } = parseDot(dot);
        const seen = this.cc.get(actor);
        if (seen === undefined) {
          if (counter === 1) { this.cc.set(actor, 1); this.dc.delete(dot); progress = true; }
        } else if (counter === seen + 1) {
          this.cc.set(actor, seen + 1); this.dc.delete(dot); progress = true;
        } else if (counter <= seen) {
          this.dc.delete(dot); // dominated, prune. No new compaction opportunity.
        }
      }
    }
    return this;
  }

  // Mint the next dot for this actor. Assumes this replica's own dots are
  // always contiguous, which holds because only the owner mints them.
  makedot(actor) {
    if (actor.includes(SEP)) throw new Error(`actor id must not contain "${SEP}": ${actor}`);
    const next = (this.cc.get(actor) || 0) + 1;
    this.cc.set(actor, next);
    return fmtDot(actor, next);
  }

  insertdot(dot, compactNow = true) {
    this.dc.add(dot);
    if (compactNow) this.compact();
    return this;
  }

  join(other) {
    if (other === this) return this; // idempotent, but skip the work
    for (const [actor, counter] of other.cc) {
      const mine = this.cc.get(actor);
      this.cc.set(actor, mine === undefined ? counter : Math.max(mine, counter));
    }
    for (const dot of other.dc) this.dc.add(dot);
    this.compact();
    return this;
  }

  // Total dots recorded, counting the version vector as the runs it stands
  // for. Diagnostic only.
  get size() { return this.cc.size + this.dc.size; }
}

// ---------------------------------------------------------------------------
// DotKernel: dots -> values, for the dots that are currently LIVE.
// The context may be owned (deltas) or shared by reference (ORMap entries).
// ---------------------------------------------------------------------------
class DotKernel {
  constructor(context) {
    this.ds = new Map();                    // dot -> value
    this.c = context || new DotContext();   // shared when supplied
  }

  join(other) {
    if (other === this) return this;

    // 1. Dots I hold that the other side does NOT hold. If their context knows
    //    the dot, they removed it, so it must go here too. If their context
    //    has never seen it, it is simply news to them: keep it.
    //    Evaluated against MY ds and THEIR context, both pre-join.
    const drop = [];
    for (const dot of this.ds.keys()) {
      if (!other.ds.has(dot) && other.c.dotin(dot)) drop.push(dot);
    }
    for (const dot of drop) this.ds.delete(dot);

    // 2. Dots they hold that I do not. Import only if my context has never
    //    seen the dot; if it has, I already removed it and must not resurrect.
    //    Checked against my context BEFORE the context join below.
    for (const [dot, val] of other.ds) {
      if (!this.ds.has(dot) && !this.c.dotin(dot)) this.ds.set(dot, val);
    }

    // 3. Contexts merge last, so steps 1 and 2 both saw the pre-join state.
    this.c.join(other.c);
    return this;
  }

  // Every mutation returns a DELTA: a standalone kernel holding just enough to
  // reproduce this change elsewhere. Deltas carry their own context, never a
  // shared one, so they can be shipped and joined independently.
  add(actor, value) {
    const dot = this.c.makedot(actor);
    this.ds.set(dot, value);
    const delta = new DotKernel();
    delta.ds.set(dot, value);
    delta.c.insertdot(dot);
    return delta;
  }

  // Remove every live dot. The delta's ds is EMPTY while its context holds the
  // removed dots - that empty-but-informed shape is exactly what tells a
  // receiving replica "I know these and chose not to have them".
  removeAll() {
    const delta = new DotKernel();
    for (const dot of this.ds.keys()) delta.c.insertdot(dot, false);
    delta.c.compact();
    this.ds.clear();
    return delta;
  }

  removeValue(value) {
    const delta = new DotKernel();
    for (const [dot, val] of [...this.ds]) {
      if (val === value) { delta.c.insertdot(dot, false); this.ds.delete(dot); }
    }
    delta.c.compact();
    return delta;
  }

  values() { return [...this.ds.values()]; }
}

// ---------------------------------------------------------------------------
// MVReg: multi-value register.
//
// A write removes every dot this register currently holds and adds exactly one
// new dot. Two actors writing concurrently therefore each remove only what
// THEY had seen, so both new dots survive the join and read() returns both.
// That is deliberate: the conflict is surfaced rather than silently resolved.
// The next write on top collapses them back to one.
// ---------------------------------------------------------------------------
class MVReg {
  constructor(actor, context) {
    this.id = actor;
    this.dk = new DotKernel(context);
  }

  write(value) {
    const removed = this.dk.removeAll();
    const added = this.dk.add(this.id, value);
    return removed.join(added); // one delta carrying both halves
  }

  read() { return this.dk.values(); }

  // Single-value convenience for cells that have never conflicted. Returns
  // undefined when empty and throws when genuinely in conflict, so a caller
  // cannot silently ignore concurrent values.
  readOne() {
    const v = this.read();
    if (v.length === 0) return undefined;
    if (v.length > 1) throw new Error(`register holds ${v.length} concurrent values: ${JSON.stringify(v)}`);
    return v[0];
  }

  reset() { return this.dk.removeAll(); }

  join(other) { this.dk.join(other.dk); return this; }
}

// ---------------------------------------------------------------------------
// ORMap: keys -> MVReg, all sharing ONE causal context.
//
// The shared context is the point of the whole structure. Metadata is O(actors)
// for the entire map rather than O(keys * actors) or O(writes).
// ---------------------------------------------------------------------------
class ORMap {
  constructor(actor) {
    this.id = actor;
    this.c = new DotContext(); // shared by reference into every entry
    this.m = new Map();        // key -> MVReg
  }

  entry(key) {
    let v = this.m.get(key);
    if (!v) { v = new MVReg(this.id, this.c); this.m.set(key, v); }
    return v;
  }

  set(key, value) { return this.entry(key).write(value); }
  get(key) { const v = this.m.get(key); return v ? v.read() : []; }
  getOne(key) { const v = this.m.get(key); return v ? v.readOne() : undefined; }
  has(key) { const v = this.m.get(key); return !!v && v.read().length > 0; }
  keys() { return [...this.m.keys()].filter(k => this.has(k)); }

  erase(key) {
    const v = this.m.get(key);
    if (!v) return new ORMap(this.id);
    const delta = v.reset();
    this.m.delete(key);
    const out = new ORMap(this.id);
    out.c = delta.c; // delta carries the removed dots, no payload
    return out;
  }

  // Joining is per-key, but every entry shares this.c, and DotKernel.join
  // merges contexts as its final step. So a naive loop would leak the other
  // replica's context into this.c partway through, and every key visited AFTER
  // that would wrongly conclude "their context knows this dot, so they removed
  // it" about dots it had only just learned of - deleting live data, with the
  // outcome depending on key iteration order.
  //
  // The fix, taken directly from the reference implementation: snapshot the
  // context, restore it after EVERY key, and join contexts exactly once at the
  // end. This is the single subtlest part of the port.
  join(other) {
    if (other === this) return this;
    const snapshot = this.c.clone();

    for (const [key, mine] of this.m) {
      const theirs = other.m.get(key);
      if (theirs) {
        mine.join(theirs);
      } else {
        // Key absent on their side. Their context may still obsolete dots I
        // hold here, so join against an EMPTY register carrying their context.
        mine.join(new MVReg(this.id, other.c));
      }
      this.c.copyFrom(snapshot);
    }

    for (const [key, theirs] of other.m) {
      if (this.m.has(key)) continue; // handled above
      this.entry(key).join(theirs);
      this.c.copyFrom(snapshot);
    }

    this.c.join(other.c); // exactly once, after every key has been resolved
    return this;
  }

  // Plain-object view of the live values, for assertions and debugging.
  snapshot() {
    const out = {};
    for (const key of [...this.m.keys()].sort()) {
      const vals = this.m.get(key).read();
      if (vals.length) out[key] = vals.length === 1 ? vals[0] : [...vals].sort();
    }
    return out;
  }
}

module.exports = { DotContext, DotKernel, MVReg, ORMap, fmtDot, parseDot };
