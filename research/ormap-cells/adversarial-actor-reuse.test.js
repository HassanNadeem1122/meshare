// STEP 4: the adversarial test for actor-id reuse.
//
// THE THREAT. meshare's live rooms name peers by SEAT, and claimSeat() hands
// out the lowest free seat (app/public/live.html). A seat is a slot, not a
// person: when someone leaves seat 0, the next joiner takes seat 0. If the
// seat name were used as the CRDT actor id, two unrelated people would mint
// dots from the same lineage - the second starting again at counter 1, on dots
// the first already used and that other replicas may still hold.
//
// This file exists to prove the failure is real, prove it is worse than "some
// data is lost", and prove that a test can actually catch it. The order
// matters: a test that passes whether or not the bug is present is worthless,
// which is the lesson this study already learned once when a partition test
// healed itself and reported success.
const test = require('node:test');
const assert = require('node:assert/strict');
const { ORMap, parseDot } = require('./ormap.js');

const snap = m => JSON.stringify(m.snapshot());

// ---------------------------------------------------------------------------
// 1. The failure, demonstrated.
// ---------------------------------------------------------------------------
test('ADVERSARIAL: reusing a seat id silently destroys BOTH peers data, and they agree about it', () => {
  // Alice takes seat 0. Carol takes seat 1 and stays for the whole scenario.
  const alice = new ORMap('seat0');
  const carol = new ORMap('seat1');
  alice.set('x', 'alice-value');
  carol.join(alice);
  assert.equal(carol.getOne('x'), 'alice-value', 'precondition: carol really has alice\'s value');

  // Alice closes her tab. Bob joins, is handed the freed seat 0, and starts
  // from an empty document - so his counter restarts at 1.
  const bob = new ORMap('seat0');
  bob.set('y', 'bob-value');

  // The collision, stated explicitly rather than implied.
  const aliceDot = [...alice.m.get('x').dk.ds.keys()][0];
  const bobDot = [...bob.m.get('y').dk.ds.keys()][0];
  assert.equal(aliceDot, bobDot,
    'the whole threat rests on these being the same dot; if they differ the scenario is not testing anything');

  carol.join(bob);
  bob.join(carol);

  // Both values are gone. Not one - both.
  assert.equal(carol.has('x'), false, 'alice\'s value was destroyed by a stranger reusing her seat');
  assert.equal(carol.has('y'), false, 'and bob\'s own value never arrived');
  assert.deepEqual(carol.snapshot(), {}, 'carol ends up holding nothing at all');
  assert.deepEqual(bob.snapshot(), {}, 'and so does bob');

  // The part that makes this genuinely dangerous.
  assert.equal(snap(carol), snap(bob),
    'the replicas AGREE on the corrupted state, so every convergence check still passes');
});

test('ADVERSARIAL: damage is proportional to how far the reused counter range overlaps', () => {
  // A first draft of this test asserted total annihilation, which is what the
  // single-key case above shows. That was an overgeneralisation and the test
  // failed. What actually happens is narrower and worse to operate: only the
  // keys whose dots fall INSIDE the second occupant's counter range are
  // destroyed. Anything the first occupant wrote beyond that range survives.
  // Partial corruption is harder to notice than total corruption, because the
  // document still looks populated.
  const first = new ORMap('seat0');
  const witness = new ORMap('seat1');
  first.set('a', '1'); first.set('b', '2'); first.set('c', '3'); // seat0:1,2,3
  witness.join(first);
  assert.equal(witness.keys().length, 3);

  const second = new ORMap('seat0');   // same id, fresh document
  second.set('d', '4'); second.set('e', '5');                    // seat0:1,2 only

  witness.join(second);
  assert.deepEqual(witness.snapshot(), { c: '3' },
    'a and b are destroyed because seat0:1 and seat0:2 collide; c survives only because ' +
    'the second occupant never minted a third dot. Nothing from the second occupant arrives at all.');
});

// ---------------------------------------------------------------------------
// 2. The fix: ids unique per session, not per seat.
// ---------------------------------------------------------------------------
// A seat number stays useful for connection routing; it just must not be the
// CRDT identity. Appending a per-session nonce is enough, and keeps the seat
// readable in logs.
const sessionId = (seat, nonce) => `seat${seat}-${nonce}`;

test('FIX: a per-session nonce on the actor id removes the collision entirely', () => {
  const alice = new ORMap(sessionId(0, 'a3f9'));
  const carol = new ORMap(sessionId(1, '77b1'));
  alice.set('x', 'alice-value');
  carol.join(alice);

  const bob = new ORMap(sessionId(0, 'c204')); // same SEAT, different session
  bob.set('y', 'bob-value');

  carol.join(bob);
  bob.join(carol);

  assert.equal(carol.getOne('x'), 'alice-value', 'alice\'s value survives her leaving');
  assert.equal(carol.getOne('y'), 'bob-value', 'and bob\'s value arrives intact');
  assert.equal(snap(carol), snap(bob), 'and the two still converge');
});

test('FIX: holds when the same seat is recycled repeatedly through many sessions', () => {
  const witness = new ORMap(sessionId(9, 'wtns'));
  const expected = {};
  for (let session = 0; session < 25; session++) {
    // Every one of these is "seat 0", claimed by a different person in turn.
    const peer = new ORMap(sessionId(0, 's' + session));
    peer.join(witness);              // catches up on room state
    peer.set('k' + session, 'v' + session);
    expected['k' + session] = 'v' + session;
    witness.join(peer);
  }
  assert.deepEqual(witness.snapshot(), expected,
    '25 successive occupants of one seat must each keep their contribution');
  // Corrected from an initial expectation of 26. The witness never writes, so
  // makedot is never called for its own id and it contributes no context
  // entry. The cost tracks actors that have WRITTEN, not actors present, which
  // is slightly better than the O(peers-ever-joined) figure quoted in
  // FINDINGS.md: a silent observer is free.
  assert.equal(witness.c.cc.size, 25,
    'one context entry per session that actually wrote, which is the cost being paid');
});

// ---------------------------------------------------------------------------
// 3. A runtime detector, and its blind spot.
// ---------------------------------------------------------------------------
// In a correct ORMap a given dot is minted exactly once, so it can only ever
// appear under one key with one value. Seeing the same dot carry different
// content is therefore PROOF of id reuse, not a heuristic. A real integration
// could refuse such a delta instead of silently corrupting itself.
function dotIndex(map) {
  const idx = new Map();
  for (const [key, reg] of map.m) {
    for (const [dot, value] of reg.dk.ds) idx.set(dot, key + '=' + value);
  }
  return idx;
}
function detectReuse(local, incoming) {
  const mine = dotIndex(local), theirs = dotIndex(incoming);
  const conflicts = [];
  for (const [dot, sig] of theirs) {
    const held = mine.get(dot);
    if (held !== undefined && held !== sig) conflicts.push({ dot, held, incoming: sig });
  }
  return conflicts;
}

test('DETECTOR: the same dot carrying different content is caught before the join', () => {
  const alice = new ORMap('seat0'), carol = new ORMap('seat1');
  alice.set('x', 'alice-value');
  carol.join(alice);
  const bob = new ORMap('seat0');
  bob.set('y', 'bob-value');

  const conflicts = detectReuse(carol, bob);
  assert.equal(conflicts.length, 1, 'carol can prove seat0 was reused before she merges anything');
  assert.equal(conflicts[0].dot, 'seat0:1');
  assert.equal(conflicts[0].held, 'x=alice-value');
  assert.equal(conflicts[0].incoming, 'y=bob-value');

  // And it must not fire on legitimate traffic.
  const honest = new ORMap(sessionId(2, 'ok'));
  honest.set('z', 'fine');
  assert.deepEqual(detectReuse(carol, honest), [], 'no false positive on a well-behaved peer');
});

test('DETECTOR BLIND SPOT: reuse is invisible when the colliding dot is only in the context', () => {
  // The detector compares live dot -> value pairs. A dot that the reusing peer
  // has already REMOVED exists only in its causal context, with no value to
  // compare against - yet it is still enough to destroy a matching dot held
  // elsewhere. This is why prevention is the real fix and detection is only a
  // safety net.
  const alice = new ORMap('seat0'), carol = new ORMap('seat1');
  alice.set('x', 'alice-value');
  carol.join(alice);                       // carol holds seat0:1 under x

  const bob = new ORMap('seat0');
  bob.set('y', 'first');                   // mints seat0:1
  bob.set('y', 'second');                  // mints seat0:2, REMOVES seat0:1

  assert.ok(bob.c.dotin('seat0:1'), 'bob\'s context still remembers the removed dot');
  assert.equal([...bob.m.get('y').dk.ds.keys()][0], 'seat0:2', 'but he no longer holds it');

  assert.deepEqual(detectReuse(carol, bob), [],
    'the detector sees no conflicting live dot, so it reports nothing');

  carol.join(bob);
  assert.equal(carol.has('x'), false,
    'and alice\'s value is destroyed anyway - undetected');
});
