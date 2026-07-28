// RESEARCH ORCHESTRATOR for the CRDT shared-state study.
// Launches a local PeerJS signalling server and one browser process per peer,
// then drives concurrent-edit, partition, late-join and reconnect scenarios
// and compares the final state every peer independently reports.
const http = require('http'), fs = require('fs'), path = require('path'), os = require('os');
const SCRATCH = 'C:/Users/Hassan/AppData/Local/Temp/claude/C--Users-Hassan-Desktop/2884ee6f-0a54-40a3-b3db-7e62478d57d5/scratchpad';
const puppeteer = require(SCRATCH + '/node_modules/puppeteer-core');
const { PeerServer } = require(SCRATCH + '/node_modules/peer');

const N = Number(process.env.N || 3);
const ROOM = 'r' + Date.now().toString(36);
const SIG_PORT = 9611 + Math.floor(Math.random() * 300);
const HERE = __dirname;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const report = { room: ROOM, peers: N, scenarios: [] };

const fileServer = http.createServer((req, res) => {
  const f = path.join(HERE, req.url.split('?')[0].replace(/^\//, ''));
  fs.readFile(f, (e, b) => {
    if (e) { res.writeHead(404); return res.end('nf'); }
    res.writeHead(200, { 'Content-Type': f.endsWith('.js') ? 'text/javascript' : 'text/html' });
    res.end(b);
  });
});

const profiles = [];
async function launchPeer(id, port) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crdt-'));
  profiles.push(dir);
  const b = await puppeteer.launch({
    executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    headless: 'new', userDataDir: dir, args: ['--no-first-run', '--disable-gpu']
  });
  const pg = await b.newPage();
  const errs = [];
  pg.on('pageerror', e => errs.push(String(e)));
  await pg.goto(`http://127.0.0.1:${port}/crdt-peer.html?id=${id}&room=${ROOM}&n=${N}` +
                `&host=127.0.0.1&port=${SIG_PORT}&path=/pg`, { waitUntil: 'domcontentloaded' });
  await pg.waitForFunction('window.__ready === true', { timeout: 60000 });
  return { id, browser: b, page: pg, errs };
}

// Every peer must independently report the same grid, the same text, and the
// same CRDT state vector. Comparing the state vector matters: two peers could
// render the same visible text while holding different underlying documents.
function compareStates(states) {
  const key = s => JSON.stringify(s.grid) + '|' + s.text;
  const keys = [...new Set(states.map(key))];
  const svs = [...new Set(states.map(s => s.stateVector))];
  return {
    converged: keys.length === 1,
    stateVectorsIdentical: svs.length === 1,
    distinctVisibleStates: keys.length,
    distinctStateVectors: svs.length,
    perPeer: states.map(s => ({ id: s.id, gridSize: s.gridSize, text: s.text, applied: s.applied, conns: s.connections }))
  };
}

(async () => {
  const sig = PeerServer({ port: SIG_PORT, path: '/pg', concurrent_limit: 500, alive_timeout: 120000 });
  await sleep(700);
  await new Promise(r => fileServer.listen(0, '127.0.0.1', r));
  const port = fileServer.address().port;
  console.log(`room=${ROOM} peers=${N} signalling=${SIG_PORT}`);

  const peers = [];
  for (let i = 0; i < N; i++) peers.push(await launchPeer(i, port));
  await sleep(6000);
  const conns = await Promise.all(peers.map(p => p.page.evaluate(() => window.connCount())));
  console.log('connections per peer:', conns.join(', '));

  const readAll = async (list = peers) => Promise.all(list.map(p => p.page.evaluate(() => window.getState())));

  // ---- Scenario A: sequential edits ----
  for (let i = 0; i < peers.length; i++) {
    await peers[i].page.evaluate(id => window.setCell('c' + id, 'peer' + id), i);
    await sleep(400);
  }
  await sleep(2500);
  let cmp = compareStates(await readAll());
  report.scenarios.push({ name: 'A sequential edits', ...cmp });
  console.log(`A sequential: converged=${cmp.converged} sameStateVector=${cmp.stateVectorsIdentical} grid=${JSON.stringify((await readAll())[0].grid)}`);

  // ---- Scenario B: all peers write the SAME cell simultaneously ----
  await Promise.all(peers.map(p => p.page.evaluate(id => window.setCell('conflict', 'from-peer-' + id), p.id)));
  await sleep(3000);
  const bStates = await readAll();
  cmp = compareStates(bStates);
  report.scenarios.push({ name: 'B concurrent same-key writes', ...cmp, winner: bStates[0].grid.conflict });
  console.log(`B concurrent same key: converged=${cmp.converged} sameStateVector=${cmp.stateVectorsIdentical} winner=${bStates[0].grid.conflict} distinct=${cmp.distinctVisibleStates}`);

  // ---- Scenario C: concurrent text insertion at the same position ----
  await Promise.all(peers.map(p => p.page.evaluate(id => window.appendText('<' + id + '>'), p.id)));
  await sleep(3000);
  const cStates = await readAll();
  cmp = compareStates(cStates);
  report.scenarios.push({ name: 'C concurrent text insert', ...cmp, text: cStates[0].text });
  console.log(`C concurrent text: converged=${cmp.converged} text="${cStates[0].text}" distinct=${cmp.distinctVisibleStates}`);

  // ---- Scenario D: partition, conflicting offline edits, then heal ----
  await peers[N - 1].page.evaluate(() => window.cutLinks());
  await sleep(3000);
  // Prove the partition is real before trusting anything the scenario reports.
  const isolatedConns = await peers[N - 1].page.evaluate(() => window.connCount());
  await peers[N - 1].page.evaluate(() => window.setCell('partitioned', 'written-while-offline'));
  await peers[N - 1].page.evaluate(() => window.setCell('conflict', 'offline-writer'));
  await peers[0].page.evaluate(() => window.setCell('partitioned', 'written-by-majority'));
  await peers[0].page.evaluate(() => window.setCell('conflict', 'online-writer'));
  await sleep(3000);
  const during = await readAll();
  const divergedDuring = compareStates(during).converged === false;
  const isolatedSaw = during[N - 1].grid.partitioned;
  const majoritySaw = during[0].grid.partitioned;
  console.log(`   partition check: isolated peer conns=${isolatedConns}, ` +
              `isolated sees "${isolatedSaw}", majority sees "${majoritySaw}"`);
  await peers[N - 1].page.evaluate(() => window.restoreLinks());
  await sleep(6000);
  const healed = await readAll();
  cmp = compareStates(healed);
  report.scenarios.push({ name: 'D partition heal', divergedWhilePartitioned: divergedDuring,
    isolatedPeerConnections: isolatedConns, isolatedSawDuringSplit: isolatedSaw, majoritySawDuringSplit: majoritySaw,
    partitionWasReal: isolatedConns === 0 && divergedDuring, ...cmp,
    partitionedCell: healed[0].grid.partitioned, conflictCell: healed[0].grid.conflict });
  console.log(`D partition: partitionWasReal=${isolatedConns === 0 && divergedDuring} divergedWhileSplit=${divergedDuring} healedConverged=${cmp.converged} sameStateVector=${cmp.stateVectorsIdentical}`);

  // ---- Scenario E: late joiner receives history, not just future edits ----
  const late = await launchPeer(N, port);
  await sleep(7000);
  const withLate = [...peers, late];
  const lateStates = await readAll(withLate);
  cmp = compareStates(lateStates);
  const lateOwn = lateStates[lateStates.length - 1];
  report.scenarios.push({ name: 'E late joiner', ...cmp, lateJoinerGridSize: lateOwn.gridSize, lateJoinerText: lateOwn.text });
  console.log(`E late join: converged=${cmp.converged} lateJoinerSawCells=${lateOwn.gridSize} text="${lateOwn.text}"`);

  // ---- Scenario F: propagation latency, edit on peer 0 seen by peer 1 ----
  const lat = [], latPure = [];
  for (let r = 0; r < 5; r++) {
    const before = await peers[1].page.evaluate(() => window.__applied);
    const t0 = Date.now();
    const sentAt = await peers[0].page.evaluate(r => window.setCell('lat' + r, 'v' + r), r);
    await peers[1].page.waitForFunction(b => window.__applied > b, { timeout: 15000 }, before);
    lat.push(Date.now() - t0);
    // In-page wall-clock difference, excluding the orchestrator's own overhead
    const appliedAt = await peers[1].page.evaluate(() => window.__lastApplyAt);
    latPure.push(appliedAt - sentAt);
    await sleep(600);
  }
  lat.sort((a, b) => a - b); latPure.sort((a, b) => a - b);
  report.scenarios.push({ name: 'F propagation latency', orchestratorMeasuredMs: lat,
    inPageMeasuredMs: latPure, medianOrchestratorMs: lat[Math.floor(lat.length / 2)],
    medianInPageMs: latPure[Math.floor(latPure.length / 2)] });
  console.log(`F latency: orchestrator ${JSON.stringify(lat)} median=${lat[Math.floor(lat.length / 2)]}ms | ` +
              `in-page ${JSON.stringify(latPure)} median=${latPure[Math.floor(latPure.length / 2)]}ms`);

  // ---- Scenario G: sustained concurrent load on overlapping keys ----
  await Promise.all(peers.map(p => p.page.evaluate(id => window.stress(100, 20, 'p' + id), p.id)));
  await sleep(8000);
  const gStates = await readAll();
  const gCmp = compareStates(gStates);
  report.scenarios.push({ name: 'G stress 100 writes x3 peers on 20 shared keys', ...gCmp,
    gridSize: gStates[0].gridSize, docBytes: gStates[0].docSizeBytes });
  console.log(`G stress: converged=${gCmp.converged} sameStateVector=${gCmp.stateVectorsIdentical} ` +
              `distinct=${gCmp.distinctVisibleStates} cells=${gStates[0].gridSize} docBytes=${gStates[0].docSizeBytes}`);

  const finalStates = await readAll(withLate);
  report.final = compareStates(finalStates);
  report.docSizeBytes = finalStates[0].docSizeBytes;
  report.pageErrors = withLate.flatMap(p => p.errs).slice(0, 5);
  console.log(`\nFINAL: converged=${report.final.converged} sameStateVector=${report.final.stateVectorsIdentical} docBytes=${report.docSizeBytes}`);
  if (report.pageErrors.length) console.error('page errors:', report.pageErrors);

  fs.writeFileSync(path.join(HERE, `crdt-results-${ROOM}.json`), JSON.stringify(report, null, 1));
  console.log('saved -> crdt-results-' + ROOM + '.json');

  for (const p of withLate) { try { await p.browser.close(); } catch {} }
  for (const d of profiles) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
  fileServer.close(); try { sig.close(); } catch {}
  process.exit(0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
