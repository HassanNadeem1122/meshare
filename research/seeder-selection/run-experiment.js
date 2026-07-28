// RESEARCH ORCHESTRATOR: launches each seeder in its OWN Chrome process (so
// seeders don't share a JS event loop and throughput reflects the path, not
// thread contention), then runs the client experiment against them.
//
//   node run-experiment.js '{"tag":"cond-b","seeders":[{"delay":0},{"delay":40},
//                            {"delay":90},{"delay":150}],"rounds":3}'
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const puppeteer = require(path.join(
  'C:/Users/Hassan/AppData/Local/Temp/claude/C--Users-Hassan-Desktop/2884ee6f-0a54-40a3-b3db-7e62478d57d5/scratchpad/node_modules/puppeteer-core'
));

const CFG = JSON.parse(process.argv[2] || '{}');
const TAG = CFG.tag || 'untagged';
const SEEDERS = CFG.seeders || [{ delay: 0 }, { delay: 0 }, { delay: 0 }, { delay: 0 }];
const ROUNDS = CFG.rounds || 3;
const BYTES = CFG.bytes || 512 * 1024;
const RELAY = CFG.relay || [];
const RUN = CFG.run || `r${Date.now()}`;
const BASE = `research-${RUN}`;
const HERE = __dirname;
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';

const server = http.createServer((req, res) => {
  const f = path.join(HERE, req.url.split('?')[0].replace(/^\//, ''));
  fs.readFile(f, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('nf'); }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(buf);
  });
});

const profiles = [];
async function launch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meshare-res-'));
  profiles.push(dir);
  return puppeteer.launch({
    executablePath: CHROME, headless: 'new', userDataDir: dir,
    args: ['--no-first-run', '--disable-gpu']
  });
}

(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const origin = `http://127.0.0.1:${port}`;
  console.log(`[${TAG}] base=${BASE} seeders=${SEEDERS.length} rounds=${ROUNDS} bytes=${BYTES} relay=[${RELAY}]`);

  const browsers = [];
  for (let i = 0; i < SEEDERS.length; i++) {
    const s = SEEDERS[i];
    const b = await launch();
    browsers.push(b);
    const pg = await b.newPage();
    const url = `${origin}/seeder-node.html?id=${BASE}-${i}&delay=${s.delay || 0}&rate=${s.rate || 0}`;
    await pg.goto(url, { waitUntil: 'domcontentloaded' });
    await pg.waitForFunction('window.__ready === true', { timeout: 60000 });
    console.log(`  seeder ${i} ready (delay=${s.delay || 0}ms rate=${s.rate || 'uncapped'}KB/s)`);
  }

  const cb = await launch();
  browsers.push(cb);
  const page = await cb.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push(String(e)));
  const curl = `${origin}/client-experiment.html?base=${BASE}&slots=${SEEDERS.length}` +
               `&rounds=${ROUNDS}&bytes=${BYTES}&relay=${RELAY.join(',')}&pings=${CFG.pings || 3}`;
  await page.goto(curl, { waitUntil: 'domcontentloaded' });
  try {
    await page.waitForFunction('window.__done === true', { timeout: 600000 });
  } catch { console.error('  TIMEOUT waiting for client'); }

  console.log(await page.evaluate(() => document.getElementById('out').textContent));
  const results = await page.evaluate(() => window.__results);
  if (errs.length) console.error('  page errors:', errs);

  const outFile = path.join(HERE, `results-${TAG}-${RUN}.json`);
  fs.writeFileSync(outFile, JSON.stringify({ tag: TAG, config: CFG, results }, null, 1));
  console.log(`\n  raw results -> ${path.basename(outFile)}`);

  for (const b of browsers) { try { await b.close(); } catch {} }
  for (const d of profiles) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
  server.close();
})().catch(e => { console.error('FATAL', e); process.exit(1); });
