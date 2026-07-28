// RESEARCH ORCHESTRATOR: starts a local PeerJS signalling server so the
// experiment is not bounded by the public server's rate limits, serves the
// prototype, and drives one run.
//
//   node run-gossip.js "n=50&k=4&mode=gossip&msgs=5"
const http = require('http'), fs = require('fs'), path = require('path'), os = require('os');
const SCRATCH = 'C:/Users/Hassan/AppData/Local/Temp/claude/C--Users-Hassan-Desktop/2884ee6f-0a54-40a3-b3db-7e62478d57d5/scratchpad';
const puppeteer = require(SCRATCH + '/node_modules/puppeteer-core');
const { PeerServer } = require(SCRATCH + '/node_modules/peer');

const QUERY = process.argv[2] || 'n=20&k=4&mode=gossip';
const TAG = (new URLSearchParams(QUERY)).get('tag') || 'run';
const SIG_PORT = 9411 + Math.floor(Math.random() * 200);
const HERE = __dirname;

const fileServer = http.createServer((req, res) => {
  const f = path.join(HERE, req.url.split('?')[0].replace(/^\//, ''));
  fs.readFile(f, (e, b) => {
    if (e) { res.writeHead(404); return res.end('nf'); }
    res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(b);
  });
});

(async () => {
  // concurrent_limit well above the room sizes under test; the point of the
  // local server is to remove signalling capacity as a variable.
  const sig = PeerServer({ port: SIG_PORT, path: '/pg', concurrent_limit: 5000, alive_timeout: 120000 });
  await new Promise(r => setTimeout(r, 800));
  await new Promise(r => fileServer.listen(0, '127.0.0.1', r));
  const port = fileServer.address().port;

  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'gossip-'));
  const browser = await puppeteer.launch({
    executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    headless: 'new', userDataDir: prof,
    args: ['--no-first-run', '--disable-gpu', '--js-flags=--max-old-space-size=4096']
  });
  const page = await browser.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push(String(e)));
  const url = `http://127.0.0.1:${port}/gossip-room.html?${QUERY}&host=127.0.0.1&port=${SIG_PORT}&path=/pg`;
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  try { await page.waitForFunction('window.__done===true', { timeout: 900000 }); }
  catch { console.error('TIMEOUT'); }

  console.log(await page.evaluate(() => document.getElementById('out').textContent));
  const results = await page.evaluate(() => window.__results);
  if (errs.length) console.error('page errors:', errs.slice(0, 3));
  if (results) {
    const f = path.join(HERE, `gossip-${TAG}-n${results.n}-${results.mode}.json`);
    fs.writeFileSync(f, JSON.stringify(results, null, 1));
    console.log('saved ->', path.basename(f));
  }

  await browser.close();
  fs.rmSync(prof, { recursive: true, force: true });
  fileServer.close();
  try { sig.close(); } catch {}
  process.exit(0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
