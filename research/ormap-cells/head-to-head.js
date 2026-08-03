// STEP 3: Yjs Y.Map vs the ORMap port, identical workloads, actual bytes.
//
// Both structures are driven from the SAME generated write sequence inside one
// process, so "identical workload" is enforced by construction rather than by
// two harnesses that are supposed to match.
//
// FAIRNESS NOTES, because a comparison this lopsided invites the question:
//   - Both are measured as full serialised state, uncompressed. Yjs via
//     encodeStateAsUpdate, ORMap via ormap-encode.js, which uses the same two
//     techniques Yjs does (LEB128 varints, an id table referenced by index).
//   - Actor ids here are realistic 8-character random strings, not 'a'. A real
//     meshare integration needs session-unique ids (see step 4), and short ids
//     would flatter the actor table.
//   - Condition C deliberately runs the ordering where Yjs does WELL, so the
//     result is not built only on Yjs's worst case.
//   - Condition D sweeps the overwrite ratio to find where the advantage ends,
//     rather than reporting only the point where it is largest.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { ORMap } = require('./ormap.js');
const { statsORMap } = require('./ormap-encode.js');

const ctx = {
  console, crypto: require('node:crypto').webcrypto,
  TextEncoder, TextDecoder, globalThis: null
};
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'crdt-state', 'yjs-bundle.js'), 'utf8'), ctx);
const Y = ctx.YJS.Y;
const ysize = doc => Y.encodeStateAsUpdate(doc).length;

// Deterministic actor ids so runs are reproducible; 8 hex chars mimics what a
// real per-session id would look like.
const actorId = i => ('actor' + i).padEnd(8, '0').slice(0, 8) + i.toString(16).padStart(2, '0');

const pct = (a, b) => (a / b).toFixed(1) + 'x';

// ---------------------------------------------------------------------------
// A. Single actor, round-robin across 20 cells. The original stress pattern.
// ---------------------------------------------------------------------------
console.log('=== A. 1 actor, 20 cells, round-robin ===');
console.log('writes\tYjs\tORMap\tratio');
for (const w of [100, 1000, 5000, 20000]) {
  const doc = new Y.Doc(); const g = doc.getMap('grid');
  const map = new ORMap(actorId(0));
  for (let i = 0; i < w; i++) {
    const k = 's' + (i % 20), v = 'a-' + i;
    g.set(k, v);
    map.set(k, v);
  }
  const yb = ysize(doc), ob = statsORMap(map).bytes;
  console.log(`${w}\t${yb}\t${ob}\t${pct(yb, ob)}`);
}

// ---------------------------------------------------------------------------
// B. Three actors writing concurrently, then fully merged. This is what the
//    CRDT study's scenario G actually did.
// ---------------------------------------------------------------------------
console.log('\n=== B. 3 actors interleaved, then all-to-all merge, 20 cells ===');
console.log('writes\tYjs\tORMap\tratio\tlive dots\tconverged');
for (const w of [1000, 20000]) {
  const docs = [0, 1, 2].map(() => new Y.Doc());
  const grids = docs.map(d => d.getMap('grid'));
  const maps = [0, 1, 2].map(i => new ORMap(actorId(i)));
  for (let i = 0; i < w; i++) {
    const p = i % 3, k = 's' + (i % 20), v = 'p' + p + '-' + i;
    grids[p].set(k, v);
    maps[p].set(k, v);
  }
  for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) if (a !== b) {
    Y.applyUpdate(docs[a], Y.encodeStateAsUpdate(docs[b]));
    maps[a].join(maps[b]);
  }
  const st = statsORMap(maps[0]);
  // 60 live dots is 3 concurrent values per cell, not a leak: no replica saw
  // any other's writes before the merge, so each actor's final write per key
  // removed only its OWN dot. Assert all three agree, or the number is a bug.
  const s0 = JSON.stringify(maps[0].snapshot());
  const agree = [1, 2].every(i => JSON.stringify(maps[i].snapshot()) === s0);
  console.log(`${w}\t${ysize(docs[0])}\t${st.bytes}\t${pct(ysize(docs[0]), st.bytes)}\t${st.liveDots}\t${agree ? 'all 3 agree' : 'DIVERGED'}`);
  if (!agree) process.exitCode = 1;
}

// ---------------------------------------------------------------------------
// C. The ordering where Yjs does WELL. Same totals, grouped by key so Yjs can
//    run-length merge. If ORMap only won on Yjs's worst case, it would show up
//    here as the advantage collapsing.
// ---------------------------------------------------------------------------
console.log('\n=== C. Same 20000 writes / 20 cells, ORDERING VARIED ===');
console.log('order\t\tYjs\tORMap\tratio');
{
  const mk = (order) => {
    const doc = new Y.Doc(); const g = doc.getMap('grid');
    const map = new ORMap(actorId(0));
    const apply = (k, v) => { g.set(k, v); map.set(k, v); };
    if (order === 'round-robin') {
      for (let i = 0; i < 20000; i++) apply('s' + (i % 20), 'a-' + i);
    } else {
      for (let k = 0; k < 20; k++) for (let i = 0; i < 1000; i++) apply('s' + k, 'a-' + i);
    }
    return [ysize(doc), statsORMap(map).bytes];
  };
  for (const order of ['round-robin', 'grouped']) {
    const [yb, ob] = mk(order);
    console.log(`${order.padEnd(12)}\t${yb}\t${ob}\t${pct(yb, ob)}`);
  }
}

// ---------------------------------------------------------------------------
// D. Where does the advantage END? Hold writes at 20000 and raise the cell
//    count until every write lands on a distinct cell. With no overwrites
//    there is no history for Yjs to accumulate, so the gap should close.
//    This is the honest boundary of the claim.
// ---------------------------------------------------------------------------
console.log('\n=== D. 20000 writes, varying cell count (overwrite ratio sweep) ===');
console.log('cells\twrites/cell\tYjs\tORMap\tratio');
for (const cells of [20, 100, 1000, 5000, 20000]) {
  const doc = new Y.Doc(); const g = doc.getMap('grid');
  const map = new ORMap(actorId(0));
  for (let i = 0; i < 20000; i++) {
    const k = 's' + (i % cells), v = 'a-' + i;
    g.set(k, v); map.set(k, v);
  }
  const yb = ysize(doc), ob = statsORMap(map).bytes;
  console.log(`${cells}\t${(20000 / cells).toFixed(0)}\t\t${yb}\t${ob}\t${pct(yb, ob)}`);
}

// ---------------------------------------------------------------------------
// E. The cost this structure DOES pay: context grows with actor count. Held
//    at a constant 20 cells and 6000 writes so only the actor count varies.
// ---------------------------------------------------------------------------
// NOTE: an earlier version of this used `i % n` for the actor and `i % 20` for
// the key, which aliases whenever gcd(n,20) > 1 - at 8 actors each one only
// ever touched 5 of the 20 keys, so 8 actors produced FEWER live dots than 3
// and the byte curve came out non-monotonic. That was a harness artifact, not
// a property of the structure. Each actor now walks its own key cycle, so
// every actor touches all 20 keys and live dots are always actors * 20.
console.log('\n=== E. ORMap cost as actor count rises (20 cells, 6000 writes) ===');
console.log('actors\tYjs\tORMap\tcontext\tlive dots\tb/actor');
for (const n of [1, 3, 8, 32, 128]) {
  const docs = Array.from({ length: n }, () => new Y.Doc());
  const grids = docs.map(d => d.getMap('grid'));
  const maps = Array.from({ length: n }, (_, i) => new ORMap(actorId(i)));
  const perActor = Math.floor(6000 / n);
  for (let p = 0; p < n; p++) {
    for (let j = 0; j < perActor; j++) {
      const k = 's' + (j % 20), v = 'p' + p + '-' + j;
      grids[p].set(k, v); maps[p].set(k, v);
    }
  }
  // merge everything into replica 0
  for (let i = 1; i < n; i++) {
    Y.applyUpdate(docs[0], Y.encodeStateAsUpdate(docs[i]));
    maps[0].join(maps[i]);
  }
  const st = statsORMap(maps[0]);
  console.log(`${n}\t${ysize(docs[0])}\t${st.bytes}\t${st.contextActors}\t${st.liveDots}\t\t${(st.bytes / n).toFixed(1)}`);
}
