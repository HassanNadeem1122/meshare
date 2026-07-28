// RESEARCH RUNNER - serves the probe harness over localhost and drives it in
// a real Chrome instance, then dumps the raw result blob as JSON.
//   node run-probe.js "seeders=4&pings=20&tag=baseline"
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const puppeteer = require(path.join(
  'C:/Users/Hassan/AppData/Local/Temp/claude/C--Users-Hassan-Desktop/2884ee6f-0a54-40a3-b3db-7e62478d57d5/scratchpad/node_modules/puppeteer-core'
));

const QUERY = process.argv[2] || 'seeders=4&pings=20&tag=untagged';
const HERE = __dirname;

const server = http.createServer((req, res) => {
  const file = path.join(HERE, req.url.split('?')[0].replace(/^\//, '') || 'probe-harness.html');
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': file.endsWith('.html') ? 'text/html' : 'text/plain' });
    res.end(buf);
  });
});

(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const url = `http://127.0.0.1:${port}/probe-harness.html?${QUERY}`;

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'meshare-research-'));
  const browser = await puppeteer.launch({
    executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    headless: 'new',
    userDataDir: profile,
    args: ['--no-first-run', '--disable-gpu']
  });
  const page = await browser.newPage();
  const consoleErrors = [];
  page.on('pageerror', e => consoleErrors.push(String(e)));
  await page.goto(url, { waitUntil: 'domcontentloaded' });

  try {
    await page.waitForFunction('window.__done === true', { timeout: 180000 });
  } catch {
    console.error('TIMED OUT waiting for harness to finish');
  }
  const results = await page.evaluate(() => window.__results);
  const text = await page.evaluate(() => document.getElementById('out').textContent);

  console.log('--- harness log ---');
  console.log(text);
  console.log('--- raw results ---');
  console.log(JSON.stringify(results, null, 1));
  if (consoleErrors.length) console.error('page errors:', consoleErrors);

  await browser.close();
  fs.rmSync(profile, { recursive: true, force: true });
  server.close();
})().catch(e => { console.error('FATAL', e); process.exit(1); });
