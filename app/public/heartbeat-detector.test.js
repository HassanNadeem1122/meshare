// Deterministic simulation comparing SymmetricDetector (today's live.html
// behavior) against AsymmetricDetector (proposed) under the same scripted
// event traces. No real WebRTC, no real timers - events carry their own
// timestamps and tick() is called on the same schedule a real 5s setInterval
// would use, so results are exact and instant instead of waiting on real
// 15-second timeouts.
const test = require('node:test');
const assert = require('node:assert/strict');
const { SymmetricDetector, AsymmetricDetector, HEARTBEAT_INTERVAL_MS } = require('./heartbeat-detector.js');

function run(DetectorClass, script, endTime) {
  const events = [];
  const d = new DetectorClass(e => events.push(e));
  let cursor = 0;
  for (const ev of script) {
    while (cursor <= ev.t) { d.tick(cursor); cursor += HEARTBEAT_INTERVAL_MS; }
    if (ev.type === 'connect') d.onConnect(ev.peer, ev.t);
    else if (ev.type === 'data') d.onData(ev.peer, ev.t);
    else if (ev.type === 'disconnect') d.onDisconnect(ev.peer, ev.t);
  }
  while (cursor <= endTime) { d.tick(cursor); cursor += HEARTBEAT_INTERVAL_MS; }
  return events;
}

// Scenario A: a flapping peer - connects and drops three times inside 12s
// (a laptop waking/sleeping, a phone switching wifi<->cellular repeatedly),
// then settles into a normal stable connection for the rest of the session.
const FLAP_SCRIPT = [
  { t: 0, type: 'connect', peer: 'A' }, { t: 100, type: 'data', peer: 'A' },
  { t: 2000, type: 'disconnect', peer: 'A' },
  { t: 4000, type: 'connect', peer: 'A' }, { t: 4100, type: 'data', peer: 'A' },
  { t: 6000, type: 'disconnect', peer: 'A' },
  { t: 8000, type: 'connect', peer: 'A' }, { t: 8100, type: 'data', peer: 'A' },
  { t: 10000, type: 'disconnect', peer: 'A' },
  { t: 12000, type: 'connect', peer: 'A' },
  { t: 12100, type: 'data', peer: 'A' }, { t: 17100, type: 'data', peer: 'A' },
  { t: 22100, type: 'data', peer: 'A' }, { t: 27100, type: 'data', peer: 'A' },
  { t: 32100, type: 'data', peer: 'A' }, { t: 37100, type: 'data', peer: 'A' },
];

// Scenario B: one legitimate brief blip on an otherwise-stable peer - e.g.
// a 3-second real network hiccup, not flapping. Peer connects, stays up,
// drops once, reconnects 3s later, stays up again.
const BLIP_SCRIPT = [
  { t: 0, type: 'connect', peer: 'B' }, { t: 100, type: 'data', peer: 'B' },
  { t: 5100, type: 'data', peer: 'B' }, { t: 10100, type: 'data', peer: 'B' },
  { t: 15100, type: 'data', peer: 'B' }, { t: 20000, type: 'disconnect', peer: 'B' },
  { t: 23000, type: 'connect', peer: 'B' }, { t: 23100, type: 'data', peer: 'B' },
  { t: 28100, type: 'data', peer: 'B' }, { t: 33100, type: 'data', peer: 'B' },
  { t: 38100, type: 'data', peer: 'B' },
];

test('flapping peer: asymmetric emits fewer joined/left events than symmetric', () => {
  const sym = run(SymmetricDetector, FLAP_SCRIPT, 40000);
  const asym = run(AsymmetricDetector, FLAP_SCRIPT, 40000);

  const symJoins = sym.filter(e => e.type === 'joined').length;
  const symLeaves = sym.filter(e => e.type === 'left').length;
  const asymJoins = asym.filter(e => e.type === 'joined').length;
  const asymLeaves = asym.filter(e => e.type === 'left').length;

  console.log(`  [flap] symmetric:  ${symJoins} joined, ${symLeaves} left  (${sym.length} total UI events)`);
  console.log(`  [flap] asymmetric: ${asymJoins} joined, ${asymLeaves} left  (${asym.length} total UI events)`);
  console.log(`  [flap] symmetric trace:  ${sym.map(e => `${e.type}@${e.at}`).join(', ')}`);
  console.log(`  [flap] asymmetric trace: ${asym.map(e => `${e.type}@${e.at}`).join(', ')}`);

  // Symmetric announces the peer every single time it reconnects (4 flaps -> 4 joins)
  // and announces it gone every time it drops (3 flaps -> 3 leaves before the final stay).
  assert.equal(symJoins, 4);
  assert.equal(symLeaves, 3);

  // Asymmetric should suppress the announcement for connections that never
  // survive long enough to pass 3 heartbeats - only the final, real
  // connection should ever be announced.
  assert.equal(asymJoins, 1);
  assert.equal(asymLeaves, 0);
  assert.ok(asymJoins + asymLeaves < symJoins + symLeaves, 'asymmetric must produce less flicker than symmetric');
});

test('legitimate blip: asymmetric delays re-trust by roughly one stabilization window', () => {
  const sym = run(SymmetricDetector, BLIP_SCRIPT, 40000);
  const asym = run(AsymmetricDetector, BLIP_SCRIPT, 40000);

  const symRejoin = sym.filter(e => e.type === 'joined')[1]; // second join = the reconnect
  const asymRejoin = asym.filter(e => e.type === 'joined')[1];

  console.log(`  [blip] symmetric re-announces "back" at t=${symRejoin.at}ms (immediately on reconnect, t=23000)`);
  console.log(`  [blip] asymmetric re-announces "back" at t=${asymRejoin.at}ms (after 3 consecutive heartbeats)`);
  console.log(`  [blip] added delay: ${asymRejoin.at - symRejoin.at}ms`);

  assert.equal(symRejoin.at, 23000); // symmetric: trusted the instant the channel reopens
  assert.ok(asymRejoin.at > symRejoin.at, 'asymmetric must be slower to re-trust even for a real blip');
  const addedDelay = asymRejoin.at - symRejoin.at;
  assert.ok(addedDelay >= 9000 && addedDelay <= 11000, `expected ~10s added delay, got ${addedDelay}ms`);
});
