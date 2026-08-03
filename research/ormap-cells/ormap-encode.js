// Binary wire encoding for ORMap state.
//
// Exists so that the size comparison against Yjs in FINDINGS.md is defensible
// rather than flattering. Yjs encodes with variable-length integers and a
// numeric client table; measuring this structure as JSON against that would
// inflate the difference for reasons that have nothing to do with the data
// model. So the same two techniques are used here:
//
//   - varint (LEB128) for every integer, so small counters cost one byte
//   - an actor table: actor ids are written ONCE, then referenced by index
//
// This is a real wire format, not a measurement trick: a meshare integration
// would need something like it anyway to ship state and deltas over a data
// channel. It is deliberately not compressed, matching Yjs, so neither side
// gets credit for gzip.
//
// Layout:
//   varint nActors, then per actor: varint byteLen, utf8 id
//   varint nCC,     then per entry: varint actorIdx, varint counter
//   varint nCloud,  then per dot:   varint actorIdx, varint counter
//   varint nKeys,   then per key:   varint byteLen, utf8 key,
//                                   varint nDots, then per dot:
//                                     varint actorIdx, varint counter,
//                                     varint byteLen, utf8 value

const { parseDot } = require('./ormap.js');

function pushVarint(out, n) {
  if (!Number.isInteger(n) || n < 0) throw new Error(`varint needs a non-negative integer, got ${n}`);
  do {
    let byte = n & 0x7f;
    n >>>= 7;
    if (n > 0) byte |= 0x80;
    out.push(byte);
  } while (n > 0);
}

function pushString(out, s) {
  const bytes = Buffer.from(String(s), 'utf8');
  pushVarint(out, bytes.length);
  for (const b of bytes) out.push(b);
}

// Encodes an ORMap's full state. Returns a Buffer; callers measure .length.
function encodeORMap(map) {
  // Actor table: every actor named anywhere in the context or in a live dot.
  const actors = [];
  const idx = new Map();
  const actorIndex = a => {
    if (!idx.has(a)) { idx.set(a, actors.length); actors.push(a); }
    return idx.get(a);
  };
  for (const a of map.c.cc.keys()) actorIndex(a);
  for (const d of map.c.dc) actorIndex(parseDot(d).actor);
  for (const reg of map.m.values()) {
    for (const d of reg.dk.ds.keys()) actorIndex(parseDot(d).actor);
  }

  const out = [];
  pushVarint(out, actors.length);
  for (const a of actors) pushString(out, a);

  pushVarint(out, map.c.cc.size);
  for (const [actor, counter] of map.c.cc) {
    pushVarint(out, actorIndex(actor));
    pushVarint(out, counter);
  }

  pushVarint(out, map.c.dc.size);
  for (const d of map.c.dc) {
    const { actor, counter } = parseDot(d);
    pushVarint(out, actorIndex(actor));
    pushVarint(out, counter);
  }

  // Only keys with live dots are written; an emptied key contributes nothing
  // beyond what its removed dots already imply in the causal context.
  const liveKeys = [...map.m.entries()].filter(([, reg]) => reg.dk.ds.size > 0);
  pushVarint(out, liveKeys.length);
  for (const [key, reg] of liveKeys) {
    pushString(out, key);
    pushVarint(out, reg.dk.ds.size);
    for (const [dot, value] of reg.dk.ds) {
      const { actor, counter } = parseDot(dot);
      pushVarint(out, actorIndex(actor));
      pushVarint(out, counter);
      pushString(out, value);
    }
  }
  return Buffer.from(out);
}

// Structural counts, independent of any encoding. These are the numbers the
// null control actually turns on: a correct implementation holds one live dot
// per cell and one context entry per actor, no matter how many writes it took
// to get there.
function statsORMap(map) {
  let liveDots = 0;
  for (const reg of map.m.values()) liveDots += reg.dk.ds.size;
  return {
    liveDots,
    liveKeys: [...map.m.values()].filter(r => r.dk.ds.size > 0).length,
    contextActors: map.c.cc.size,
    dotCloud: map.c.dc.size,
    bytes: encodeORMap(map).length
  };
}

module.exports = { encodeORMap, statsORMap };
