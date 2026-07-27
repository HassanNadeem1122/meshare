// Peer trust/failure detector for live rooms.
//
// Both detectors share fast-drop: a peer silent for SILENT_TIMEOUT_MS is
// dropped immediately, full stop - "bad news" always travels fast, because
// a stale peer wastes a chat send or blocks a UI decision the instant it
// happens. They differ only in "good news": SymmetricDetector trusts a
// reconnecting peer the moment its channel opens (today's live.html
// behavior). AsymmetricDetector requires STABILIZE_COUNT consecutive
// heartbeats before re-announcing a peer as trusted, per Alaettinoglu/
// Jacobson/Yu's "Toward Millisecond IGP Convergence": react fast to bad
// news, filter noisy good news to avoid flapping instability.
//
// Pure logic, no timers, no network - callers push timestamped events in
// (onConnect/onData/onDisconnect) and call tick(now) periodically; the
// detector emits {type:'joined'|'left', peerId, at} through onEvent.
// This is what makes it unit-testable with a fake clock instead of real
// 5s/15s waits.

const HEARTBEAT_INTERVAL_MS = 5000;
const SILENT_TIMEOUT_MS = 15000;
const STABILIZE_COUNT = 3; // consecutive heartbeats required before re-trust

class BaseDetector {
  constructor(onEvent) {
    this.onEvent = onEvent || (() => {});
    this.peers = new Map(); // peerId -> { lastSeen, trusted, streak }
  }
  _emit(type, peerId, at) { this.onEvent({ type, peerId, at }); }
  onDisconnect(peerId, at) {
    const p = this.peers.get(peerId);
    this.peers.delete(peerId);
    if (p && p.trusted) this._emit('left', peerId, at);
  }
  tick(now) {
    for (const [peerId, p] of [...this.peers]) {
      if (now - p.lastSeen > SILENT_TIMEOUT_MS) {
        const wasTrusted = p.trusted;
        this.peers.delete(peerId);
        if (wasTrusted) this._emit('left', peerId, now);
      }
    }
  }
}

// Today's live.html behavior: trust on connect, no debounce on return.
class SymmetricDetector extends BaseDetector {
  onConnect(peerId, at) {
    const existing = this.peers.get(peerId);
    if (existing) { existing.lastSeen = at; return; } // already tracked, e.g. reconnect race
    this.peers.set(peerId, { lastSeen: at, trusted: true, streak: 0 });
    this._emit('joined', peerId, at);
  }
  onData(peerId, at) {
    const p = this.peers.get(peerId);
    if (p) p.lastSeen = at;
  }
}

// Proposed: connecting only starts probation. A peer needs STABILIZE_COUNT
// consecutive heartbeats (roughly one per HEARTBEAT_INTERVAL_MS) before
// it's announced as trusted. Any disconnect or silence-timeout still drops
// immediately and resets the streak - "bad news" is never slowed down.
class AsymmetricDetector extends BaseDetector {
  onConnect(peerId, at) {
    const existing = this.peers.get(peerId);
    if (existing) { existing.lastSeen = at; return; }
    this.peers.set(peerId, { lastSeen: at, trusted: false, streak: 0 });
    // No 'joined' event yet - peer is on probation.
  }
  onData(peerId, at) {
    const p = this.peers.get(peerId);
    if (!p) return;
    p.lastSeen = at;
    if (p.trusted) return; // already fully trusted, data just keeps it alive
    p.streak += 1;
    if (p.streak >= STABILIZE_COUNT) {
      p.trusted = true;
      this._emit('joined', peerId, at);
    }
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { SymmetricDetector, AsymmetricDetector, HEARTBEAT_INTERVAL_MS, SILENT_TIMEOUT_MS, STABILIZE_COUNT };
}
if (typeof window !== 'undefined') {
  window.MeshareHeartbeat = { SymmetricDetector, AsymmetricDetector, HEARTBEAT_INTERVAL_MS, SILENT_TIMEOUT_MS, STABILIZE_COUNT };
}
