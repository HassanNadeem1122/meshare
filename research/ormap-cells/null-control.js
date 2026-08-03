// STEP 2: null control for the ORMap port.
//
// One actor. 20,000 writes. 20 cells. Round-robin order - deliberately the
// exact workload that made the Yjs prototype grow to ~183 KB, so that if this
// structure has the same problem it shows up under the same conditions rather
// than under a kinder one.
//
// WHAT MUST HOLD. Growth is claimed to be a function of cell count and actor
// count, not write count. So across 100 and 20,000 writes:
//
//   liveDots      must stay 20   (one per cell, old ones removed not retained)
//   contextActors must stay 1    (one writer)
//   dotCloud      must stay 0    (a single actor's own dots are contiguous)
//
// Those three are encoding-independent, which is the point: they cannot be
// made to look good by choosing a favourable serialisation. Bytes are reported
// too, but the structural counts are what this control actually turns on.
//
// IF THIS GROWS, THE PORT IS WRONG and nothing downstream is worth running.
// The most likely bug it would catch is DotKernel.removeAll failing to clear
// old dots, which would silently rebuild the very operation log this structure
// exists to avoid.
const { ORMap } = require('./ormap.js');
const { statsORMap } = require('./ormap-encode.js');

const KEYS = 20;
const CHECKPOINTS = [100, 1000, 5000, 20000];

function run(writes) {
  const map = new ORMap('a');
  for (let i = 0; i < writes; i++) map.set('s' + (i % KEYS), 'a-' + i);
  return { writes, ...statsORMap(map) };
}

const rows = CHECKPOINTS.map(run);

console.log('=== NULL CONTROL: 1 actor, 20 cells, round-robin ===\n');
console.log('writes\tliveDots\tkeys\tactors\tcloud\tbytes\tb/write');
for (const r of rows) {
  console.log(`${r.writes}\t${r.liveDots}\t\t${r.liveKeys}\t${r.contextActors}\t${r.dotCloud}\t${r.bytes}\t${(r.bytes / r.writes).toFixed(4)}`);
}

// --- assertions -----------------------------------------------------------
let failed = false;
const check = (cond, msg) => { if (!cond) { console.log(`\nFAIL: ${msg}`); failed = true; } };

for (const r of rows) {
  check(r.liveDots === KEYS, `${r.writes} writes left ${r.liveDots} live dots, expected ${KEYS} - old dots are being retained`);
  check(r.liveKeys === KEYS, `${r.writes} writes left ${r.liveKeys} live keys, expected ${KEYS}`);
  check(r.contextActors === 1, `${r.writes} writes produced ${r.contextActors} context actors, expected 1`);
  check(r.dotCloud === 0, `${r.writes} writes left ${r.dotCloud} dots stranded in the cloud, expected 0`);
}

// Bytes are allowed to creep, but only logarithmically: the varint holding a
// counter of 20000 is 3 bytes where a counter of 100 is 1, and the value
// strings 'a-19999' are longer than 'a-99'. Linear growth would mean the
// structure is accumulating per-write state and the whole premise is wrong.
const first = rows[0], last = rows[rows.length - 1];
const writeRatio = last.writes / first.writes;      // 200x
const byteRatio = last.bytes / first.bytes;
console.log(`\nwrites grew ${writeRatio}x, bytes grew ${byteRatio.toFixed(2)}x`);
check(byteRatio < 2, `bytes grew ${byteRatio.toFixed(2)}x against a ${writeRatio}x increase in writes - that is not flat`);

// Direct comparison against the measured Yjs figure for the identical workload.
const YJS_20K = 183719;
console.log(`\nYjs, same workload, same 20 cells: ${YJS_20K} bytes`);
console.log(`ORMap, same workload:              ${last.bytes} bytes`);
console.log(`ratio:                             ${(YJS_20K / last.bytes).toFixed(1)}x smaller`);

console.log(failed ? '\nNULL CONTROL FAILED' : '\nNULL CONTROL PASSED');
process.exit(failed ? 1 : 0);
