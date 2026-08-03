// Step 1 of validating the ORMap proposal in FINDINGS.md: does the port behave
// like a CRDT at all? Size is NOT tested here - that is step 2 onward. What is
// tested here is correctness, because a structure that converges to the WRONG
// value while staying small would be worse than the Yjs growth problem, not
// better.
//
// The load-bearing tests are the semi-lattice laws (commutative, associative,
// idempotent). Those three are what "converges without a coordinator" actually
// means: peers may merge in any order, repeatedly, with duplicates, and still
// agree. Everything else in this file is a specific behaviour; those three are
// the guarantee.
const test = require('node:test');
const assert = require('node:assert/strict');
const { DotContext, MVReg, ORMap } = require('./ormap.js');

const snap = m => JSON.stringify(m.snapshot());

// ---------------------------------------------------------------------------
// DotContext
// ---------------------------------------------------------------------------
test('DotContext: makedot issues contiguous dots and dotin recognises them', () => {
  const c = new DotContext();
  assert.equal(c.makedot('a'), 'a:1');
  assert.equal(c.makedot('a'), 'a:2');
  assert.equal(c.makedot('b'), 'b:1');
  assert.ok(c.dotin('a:1') && c.dotin('a:2') && c.dotin('b:1'));
  assert.ok(!c.dotin('a:3'), 'a dot never issued must not read as seen');
});

test('DotContext: compact folds contiguous dots into the version vector, keeps gaps in the cloud', () => {
  const c = new DotContext();
  c.insertdot('a:1'); c.insertdot('a:2');
  assert.equal(c.cc.get('a'), 2);
  assert.equal(c.dc.size, 0, 'contiguous dots must not linger in the dot cloud');

  c.insertdot('a:5'); // gap at 3,4
  assert.equal(c.cc.get('a'), 2);
  assert.equal(c.dc.size, 1, 'a dot past a gap has to stay in the cloud');

  c.insertdot('a:4'); c.insertdot('a:3');
  assert.equal(c.cc.get('a'), 5, 'filling the gap should drain the whole cloud');
  assert.equal(c.dc.size, 0);
});

test('DotContext: join takes the pointwise maximum', () => {
  const x = new DotContext(); x.insertdot('a:1'); x.insertdot('a:2'); x.insertdot('b:1');
  const y = new DotContext(); y.insertdot('a:1'); y.insertdot('c:1');
  x.join(y);
  assert.equal(x.cc.get('a'), 2);
  assert.equal(x.cc.get('b'), 1);
  assert.equal(x.cc.get('c'), 1);
});

// ---------------------------------------------------------------------------
// MVReg
// ---------------------------------------------------------------------------
test('MVReg: sequential writes by one actor leave exactly one value', () => {
  const r = new MVReg('a');
  r.write('v1'); r.write('v2'); r.write('v3');
  assert.deepEqual(r.read(), ['v3']);
  assert.equal(r.dk.ds.size, 1, 'old writes must not accumulate live dots');
});

test('MVReg: concurrent writes from two actors both survive, then collapse on the next write', () => {
  const a = new MVReg('a'), b = new MVReg('b');
  a.write('from-a');
  b.write('from-b');            // concurrent: neither saw the other
  a.join(b);
  assert.deepEqual(a.read().sort(), ['from-a', 'from-b'],
    'a multi-value register must surface the conflict, not silently pick');
  assert.throws(() => a.readOne(), /concurrent values/,
    'readOne must refuse to hide a genuine conflict');

  a.write('resolved');          // a write observes both and removes both
  assert.deepEqual(a.read(), ['resolved']);
});

// ---------------------------------------------------------------------------
// The semi-lattice laws. These are the actual convergence guarantee.
// ---------------------------------------------------------------------------
// Three replicas with overlapping and conflicting edits, rebuilt fresh for
// each law so that mutation during one join cannot leak into the next check.
function scenario() {
  const a = new ORMap('a'), b = new ORMap('b'), c = new ORMap('c');
  a.set('x', 'a-x'); a.set('y', 'a-y');
  b.set('x', 'b-x');                 // conflicts with a on x
  b.set('z', 'b-z');
  c.set('y', 'c-y');                 // conflicts with a on y
  return { a, b, c };
}

test('LAW: join is commutative - merge order does not change the result', () => {
  const s1 = scenario(); s1.a.join(s1.b);
  const s2 = scenario(); s2.b.join(s2.a);
  assert.equal(snap(s1.a), snap(s2.b), 'a join b must equal b join a');
});

test('LAW: join is idempotent - merging the same state twice changes nothing', () => {
  const { a, b } = scenario();
  a.join(b);
  const once = snap(a);
  a.join(b); a.join(b);
  assert.equal(snap(a), once, 'repeated delivery of the same state must be a no-op');
});

test('LAW: join is associative - grouping does not change the result', () => {
  const s1 = scenario(); s1.a.join(s1.b); s1.a.join(s1.c);   // (a . b) . c
  const s2 = scenario(); s2.b.join(s2.c); s2.a.join(s2.b);   // a . (b . c)
  assert.equal(snap(s1.a), snap(s2.a), 'grouping of merges must not matter');
});

test('all three replicas converge to identical state regardless of merge path', () => {
  const { a, b, c } = scenario();
  // deliberately different, messy merge orders per replica, with duplicates
  a.join(b); a.join(c); a.join(b);
  b.join(c); b.join(a);
  c.join(a); c.join(b); c.join(a);
  assert.equal(snap(a), snap(b));
  assert.equal(snap(b), snap(c));
  assert.deepEqual(a.snapshot(), {
    x: ['a-x', 'b-x'],   // genuine concurrent conflict, both retained
    y: ['a-y', 'c-y'],   // ditto
    z: 'b-z'
  });
});

// ---------------------------------------------------------------------------
// ORMap specifics
// ---------------------------------------------------------------------------
test('ORMap: writes to independent keys do not interfere', () => {
  const a = new ORMap('a');
  for (let i = 0; i < 50; i++) a.set('k' + (i % 10), 'v' + i);
  assert.equal(a.keys().length, 10);
  for (let k = 0; k < 10; k++) {
    assert.equal(a.getOne('k' + k), 'v' + (40 + k), 'each cell keeps only its own latest write');
  }
});

// This is the test for the subtlest part of the port: ORMap.join snapshots the
// shared causal context and restores it after every key. Without that restore,
// joining the FIRST key leaks the other replica's whole context into this.c,
// and every later key then treats the other side's dots as already-seen and
// silently refuses to import them. The visible symptom is lost data on keys
// that happen to be visited later.
test('ORMap: join does not lose keys visited after the first (the context-restore bug)', () => {
  const a = new ORMap('a'), b = new ORMap('b');
  a.set('k1', 'a-1');           // a knows only k1
  b.join(a);                    // b learns k1
  b.set('k1', 'b-1');           // b overwrites it
  b.set('k2', 'b-2');           // and adds a key a has never seen

  a.join(b);
  assert.equal(a.getOne('k1'), 'b-1', 'b observed and overwrote a\'s k1');
  assert.equal(a.getOne('k2'), 'b-2',
    'k2 is visited after k1; without the context restore it would be silently dropped');
});

test('ORMap: an erased key is not resurrected by a peer that still holds it', () => {
  const a = new ORMap('a'), b = new ORMap('b');
  a.set('gone', 'value');
  b.join(a);                    // b now holds it too
  a.erase('gone');              // a removes it, context remembers the dot
  a.join(b);                    // b still has the old dot
  assert.equal(a.has('gone'), false, 'a removal must survive meeting a stale replica');
  b.join(a);
  assert.equal(b.has('gone'), false, 'and must propagate to that replica');
});

test('ORMap: a concurrent write beats a concurrent erase (add-wins)', () => {
  const a = new ORMap('a'), b = new ORMap('b');
  a.set('k', 'original');
  b.join(a);
  a.erase('k');                 // concurrent with...
  b.set('k', 'rewritten');      // ...b writing a brand new dot a never saw
  a.join(b);
  assert.equal(a.getOne('k'), 'rewritten',
    'the erase only observed the original dot, so the new write survives');
});

test('ORMap: a fresh replica joining an established one receives everything', () => {
  const a = new ORMap('a');
  a.set('x', '1'); a.set('y', '2'); a.set('z', '3'); a.set('x', '4');
  const late = new ORMap('late');
  late.join(a);
  assert.deepEqual(late.snapshot(), { x: '4', y: '2', z: '3' });
});
