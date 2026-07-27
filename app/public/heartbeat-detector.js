// Peer trust/failure detector for live rooms.
//
// Both detectors share fast-drop: a peer that goes silent is dropped as soon
// as the app's heartbeat loop notices - "bad news" always travels fast,
// because a stale peer in the member list is actively misleading. They
// differ only in "good news": SymmetricDetector trusts a peer the moment its
// channel opens (live.html's original behavior). AsymmetricDetector makes a
// new or reconnecting peer prove durability first, per Alaettinoglu/Jacobson/
// Yu's "Toward Millisecond IGP Convergence": react fast to bad news, filter
// noisy good news so a flapping link can't spam the room.
//
// Trust requires BOTH proof of life (at least one inbound message) and proof
// of durability (the connection has survived STABILIZE_MS). Counting inbound
// messages alone is not enough: a chatty peer would burst three messages in
// milliseconds and be trusted instantly, which is precisely the flapping
// case this is meant to filter out.
//
// No timers and no network in here - the app pushes timestamped events in
// (onConnect/onData/onDisconnect), asks silentPeers(now) from its own
// heartbeat loop, and receives {type:'joined'|'left', peerId, at} through
// onEvent. That is what makes this testable against a fake clock instead of
// real 5s/15s waits, and it means the tests drive exactly the same code path
// production does.

const HEARTBEAT_INTERVAL_MS = 5000;
const SILENT_TIMEOUT_MS = 15000;
const STABILIZE_MS = 10000; // connection lifetime required before re-trust

class BaseDetector {
  constructor(onEvent) {
    this.onEvent = onEvent || (() => {});
    this.peers = new Map(); // peerId -> { connectedAt, lastSeen, trusted }
  }
  _emit(type, peerId, at) { this.onEvent({ type, peerId, at }); }

  onDisconnect(peerId, at) {
    const p = this.peers.get(peerId);
    this.peers.delete(peerId);
    if (p && p.trusted) this._emit('left', peerId, at);
  }

  // Peers whose last inbound message is older than SILENT_TIMEOUT_MS. The
  // app's existing heartbeat loop calls this and then onDisconnect() for
  // each - this module deliberately owns no timer of its own, so there is
  // exactly one expiry path and the tests exercise the real one.
  silentPeers(now) {
    const out = [];
    for (const [peerId, p] of this.peers) {
      if (now - p.lastSeen > SILENT_TIMEOUT_MS) out.push(peerId);
    }
    return out;
  }

  isTrusted(peerId) {
    const p = this.peers.get(peerId);
    return !!(p && p.trusted);
  }
}

// live.html's original behavior, kept for side-by-side comparison in tests.
class SymmetricDetector extends BaseDetector {
  onConnect(peerId, at) {
    const existing = this.peers.get(peerId);
    if (existing) { existing.lastSeen = at; return; }
    this.peers.set(peerId, { connectedAt: at, lastSeen: at, trusted: true });
    this._emit('joined', peerId, at);
  }
  onData(peerId, at) {
    const p = this.peers.get(peerId);
    if (p) p.lastSeen = at;
  }
}

// Connecting only starts probation; the peer is announced once it has both
// spoken at least once and stayed up for STABILIZE_MS. Disconnects and
// silence-timeouts still drop instantly and wipe the probation state, so
// "bad news" is never delayed.
class AsymmetricDetector extends BaseDetector {
  onConnect(peerId, at) {
    const existing = this.peers.get(peerId);
    if (existing) { existing.lastSeen = at; return; }
    this.peers.set(peerId, { connectedAt: at, lastSeen: at, trusted: false });
  }
  onData(peerId, at) {
    const p = this.peers.get(peerId);
    if (!p) return;
    p.lastSeen = at;
    if (p.trusted) return;
    if (at - p.connectedAt >= STABILIZE_MS) {
      p.trusted = true;
      this._emit('joined', peerId, at);
    }
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { SymmetricDetector, AsymmetricDetector, HEARTBEAT_INTERVAL_MS, SILENT_TIMEOUT_MS, STABILIZE_MS };
}
if (typeof window !== 'undefined') {
  window.MeshareHeartbeat = { SymmetricDetector, AsymmetricDetector, HEARTBEAT_INTERVAL_MS, SILENT_TIMEOUT_MS, STABILIZE_MS };
}
