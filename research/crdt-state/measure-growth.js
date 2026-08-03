// Document-growth measurement for the CRDT study.
//
// Separate from run-crdt.js on purpose: growth is a purely LOCAL property of
// the Yjs document, so it needs no peers, no signalling and no browser. That
// makes it exactly reproducible, unlike the convergence scenarios. It runs the
// same yjs-bundle.js the browser prototype uses, loaded into a Node VM
// context, so the numbers describe the same library version the study tested.
//
// Written after the first pass of this study attributed unbounded growth to
// CRDT history retention in general. That attribution was wrong, and this
// harness is what showed it: the dominant term is Yjs struct fragmentation
// driven by WRITE ORDER, not by write count or by CRDTs as a class. See
// FINDINGS.md, "What actually drives the growth".
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ctx = {
  console,
  crypto: require('node:crypto').webcrypto,
  TextEncoder, TextDecoder,
  globalThis: null
};
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, 'yjs-bundle.js'), 'utf8'), ctx);
const Y = ctx.YJS.Y;

const size = doc => Y.encodeStateAsUpdate(doc).length;
const WRITES = 20000;
const KEYS = 20;

// ---------------------------------------------------------------------------
// 1. Is gc the confound? crdt-peer.html calls `new Y.Doc()` with no options.
//    Yjs's own default is gc:true, so the prototype was ALREADY collecting.
// ---------------------------------------------------------------------------
function mapRoundRobin(writes, keys, gc) {
  const doc = new Y.Doc({ gc });
  const g = doc.getMap('grid');
  for (let i = 0; i < writes; i++) g.set('s' + (i % keys), 'a-' + i);
  return size(doc);
}

console.log('=== 1. Y.Map round-robin, gc on vs off ===');
console.log('writes\tgc:true\tgc:false');
for (const w of [100, 1000, 5000, WRITES]) {
  console.log(`${w}\t${mapRoundRobin(w, KEYS, true)}\t${mapRoundRobin(w, KEYS, false)}`);
}

// ---------------------------------------------------------------------------
// 2. The decisive test. Identical write count, identical key count, identical
//    final values. ONLY the interleaving differs. If growth were inherent to
//    retaining history, these would match.
// ---------------------------------------------------------------------------
console.log('\n=== 2. Same 20000 writes to same 20 keys, different ORDER ===');
{
  const rr = new Y.Doc(), g1 = rr.getMap('g');
  for (let i = 0; i < WRITES; i++) g1.set('s' + (i % KEYS), 'a-' + i);

  const grouped = new Y.Doc(), g2 = grouped.getMap('g');
  for (let k = 0; k < KEYS; k++)
    for (let i = 0; i < WRITES / KEYS; i++) g2.set('s' + k, 'a-' + i);

  // Batching rounds into one transaction, to rule out transaction boundaries
  // as the cause rather than struct adjacency.
  const txn = new Y.Doc(), g3 = txn.getMap('g');
  for (let r = 0; r < WRITES / KEYS; r++)
    txn.transact(() => { for (let k = 0; k < KEYS; k++) g3.set('s' + k, 'a-' + r); });

  console.log(`round-robin across 20 keys : ${size(rr)}`);
  console.log(`grouped by key             : ${size(grouped)}`);
  console.log(`round-robin, batched in txn: ${size(txn)}`);
}

// ---------------------------------------------------------------------------
// 3. Key count is not the driver either; adjacency is.
// ---------------------------------------------------------------------------
console.log('\n=== 3. 20000 writes, varying distinct key count (all round-robin) ===');
console.log('keys\tbytes\tb/write');
for (const keys of [1, 2, 5, 20, 100, 1000]) {
  const b = mapRoundRobin(WRITES, keys, true);
  console.log(`${keys}\t${b}\t${(b / WRITES).toFixed(2)}`);
}

// ---------------------------------------------------------------------------
// 4. Same effect in Y.Text, which proves it is not a Map-vs-Text distinction.
//    Contiguous edits merge into runs; scattered ones do not.
// ---------------------------------------------------------------------------
console.log('\n=== 4. Y.Text: contiguity, not datatype ===');
{
  const a = new Y.Doc(), ta = a.getText('t');
  for (let i = 0; i < 5000; i++) ta.insert(ta.length, 'x');       // append
  const b = new Y.Doc(), tb = b.getText('t');
  for (let i = 0; i < 5000; i++) tb.insert(0, 'x');               // prepend
  const c = new Y.Doc(), tc = c.getText('t');
  tc.insert(0, 'hello');
  for (let i = 0; i < 5000; i++) { tc.delete(0, tc.length); tc.insert(0, 'v' + i); }
  console.log(`append 5000 chars          : ${size(a)}`);
  console.log(`insert-at-front 5000 chars : ${size(b)}`);
  console.log(`5000 delete+reinsert cycles: ${size(c)}`);
}

// ---------------------------------------------------------------------------
// 5. Compaction, and why merging a compacted copy back in makes it BIGGER.
//    The rebuilt doc is a new clientID's operations, not a smaller version of
//    the same ones, and merge is a join: it can only ever go up.
// ---------------------------------------------------------------------------
console.log('\n=== 5. Compaction and merge-back ===');
{
  const full = new Y.Doc(), fg = full.getMap('g');
  for (let i = 0; i < WRITES; i++) fg.set('s' + (i % KEYS), 'a-' + i);
  const fullBytes = size(full);

  const comp = new Y.Doc(), cg = comp.getMap('g');
  for (const [k, v] of fg.entries()) cg.set(k, v);
  const compBytes = size(comp);

  Y.applyUpdate(full, Y.encodeStateAsUpdate(comp));
  console.log(`full history            : ${fullBytes}`);
  console.log(`rebuilt from values only: ${compBytes}`);
  console.log(`after merging back in   : ${size(full)}  <-- larger, not smaller`);
  console.log(`same clientID?          : ${full.clientID === comp.clientID}`);
}
