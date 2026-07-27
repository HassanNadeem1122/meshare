// Deterministic simulation comparing SymmetricDetector (live.html's original
// behavior) against AsymmetricDetector under identical scripted event traces.
// No real WebRTC and no real timers: events carry their own timestamps, and
// the harness runs the same loop live.html runs - ping the peers, ask
// silentPeers(now), drop whatever came back - so the tested expiry path is
// the production expiry path, not a test-only shortcut.
const test = require('node:test');
const assert = require('node:assert/strict');
const { SymmetricDetector, AsymmetricDetector, HEARTBEAT_INTERVAL_MS, STABILIZE_MS } = require('./heartbeat-detector.js');

function run(DetectorClass, script, endTime) {
  const events = [];
  const d = new DetectorClass(e => events.push(e));
  const heartbeat = now => { for (const id of d.silentPeers(now)) d.onDisconnect(id, now); };
  let cursor = 0;
  for (const ev of script) {
    while (cursor <= ev.t) { heartbeat(cursor); cursor += HEARTBEAT_INTERVAL_MS; }
    if (ev.type === 'connect') d.onConnect(ev.peer, ev.t);
    else if (ev.type === 'data') d.onData(ev.peer, ev.t);
    else if (ev.type === 'disconnect') d.onDisconnect(ev.peer, ev.t);
  }
  while (cursor <= endTime) { heartbeat(cursor); cursor += HEARTBEAT_INTERVAL_MS; }
  return events;
}

// A flapping peer: connects and drops three times inside 12s (a laptop
// waking and sleeping, a phone bouncing between wifi and cellular), then
// settles into a normal stable connection with pings every ~5s.
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

// One legitimate brief blip on an otherwise-stable peer: a ~3s real network
// hiccup, not flapping.
const BLIP_SCRIPT = [
  { t: 0, type: 'connect', peer: 'B' }, { t: 100, type: 'data', peer: 'B' },
  { t: 5100, type: 'data', peer: 'B' }, { t: 10100, type: 'data', peer: 'B' },
  { t: 15100, type: 'data', peer: 'B' }, { t: 20000, type: 'disconnect', peer: 'B' },
  { t: 23000, type: 'connect', peer: 'B' }, { t: 23100, type: 'data', peer: 'B' },
  { t: 28100, type: 'data', peer: 'B' }, { t: 33100, type: 'data', peer: 'B' },
  { t: 38100, type: 'data', peer: 'B' },
];

// A chatty peer that bursts several messages immediately on connect. This is
// the case a message-count threshold gets wrong: activity is not durability,
// and a flapping peer that talks the moment it reconnects would otherwise
// buy its way to trusted instantly.
const CHATTY_BURST_SCRIPT = [
  { t: 0, type: 'connect', peer: 'C' },
  { t: 10, type: 'data', peer: 'C' }, { t: 20, type: 'data', peer: 'C' },
  { t: 30, type: 'data', peer: 'C' }, { t: 40, type: 'data', peer: 'C' },
  { t: 5000, type: 'data', peer: 'C' }, { t: 10000, type: 'data', peer: 'C' },
  { t: 15000, type: 'data', peer: 'C' },
];

test('flapping peer: asymmetric emits far less join/leave churn', () => {
  const sym = run(SymmetricDetector, FLAP_SCRIPT, 40000);
  const asym = run(AsymmetricDetector, FLAP_SCRIPT, 40000);
  const count = (evts, t) => evts.filter(e => e.type === t).length;

  console.log(`  [flap] symmetric:  ${count(sym, 'joined')} joined, ${count(sym, 'left')} left  (${sym.length} UI events)`);
  console.log(`  [flap] asymmetric: ${count(asym, 'joined')} joined, ${count(asym, 'left')} left  (${asym.length} UI events)`);
  console.log(`  [flap] symmetric trace:  ${sym.map(e => `${e.type}@${e.at}`).join(', ')}`);
  console.log(`  [flap] asymmetric trace: ${asym.map(e => `${e.type}@${e.at}`).join(', ')}`);

  assert.equal(count(sym, 'joined'), 4);
  assert.equal(count(sym, 'left'), 3);
  assert.equal(count(asym, 'joined'), 1);
  assert.equal(count(asym, 'left'), 0);
});

test('legitimate blip: asymmetric costs one stabilization window of delay', () => {
  const sym = run(SymmetricDetector, BLIP_SCRIPT, 40000);
  const asym = run(AsymmetricDetector, BLIP_SCRIPT, 40000);
  const symRejoin = sym.filter(e => e.type === 'joined')[1];
  const asymRejoin = asym.filter(e => e.type === 'joined')[1];

  console.log(`  [blip] symmetric re-announces at t=${symRejoin.at} (instantly on reconnect)`);
  console.log(`  [blip] asymmetric re-announces at t=${asymRejoin.at}`);
  console.log(`  [blip] added delay: ${asymRejoin.at - symRejoin.at}ms`);

  assert.equal(symRejoin.at, 23000);
  const addedDelay = asymRejoin.at - symRejoin.at;
  assert.ok(addedDelay >= STABILIZE_MS, `expected at least one ${STABILIZE_MS}ms window, got ${addedDelay}ms`);
});

test('a burst of messages does not substitute for staying connected', () => {
  const asym = run(AsymmetricDetector, CHATTY_BURST_SCRIPT, 20000);
  const joined = asym.find(e => e.type === 'joined');
  console.log(`  [burst] 4 messages within 40ms of connecting -> trusted at t=${joined ? joined.at : 'never'}`);
  assert.ok(joined, 'peer should eventually be trusted');
  assert.ok(joined.at >= STABILIZE_MS, `trust must wait ${STABILIZE_MS}ms of uptime, got ${joined.at}ms`);
});

test('silence expiry runs through the same path production uses', () => {
  // No explicit disconnect event: the peer simply stops responding, and only
  // the heartbeat sweep (silentPeers -> onDisconnect) can notice.
  const script = [
    { t: 0, type: 'connect', peer: 'D' }, { t: 100, type: 'data', peer: 'D' },
    { t: 5100, type: 'data', peer: 'D' }, { t: 10100, type: 'data', peer: 'D' },
    { t: 15100, type: 'data', peer: 'D' },
  ];
  const asym = run(AsymmetricDetector, script, 60000);
  const joined = asym.find(e => e.type === 'joined');
  const left = asym.find(e => e.type === 'left');
  console.log(`  [silence] joined@${joined && joined.at}, left@${left && left.at} (last message was t=15100)`);
  assert.ok(joined, 'peer was trusted while alive');
  assert.ok(left, 'peer must be dropped after going silent');
  assert.ok(left.at - 15100 <= 20000, 'drop should follow silence promptly');
});
