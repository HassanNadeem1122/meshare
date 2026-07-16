#!/usr/bin/env node
// meshare CLI: `meshare <file>` -> shareable link + QR + live seeder terminal.
// Stage 7: --name/--expires/--password, R2 backup upload, `meshare revoke <id>`.
// Node has no WebRTC, so the CLI opens a local seeder page in the browser;
// that tab does the actual P2P serving and reports back here.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');
const qrcode = require('qrcode-terminal');

const APP_URL = 'https://meshare.meshareapp.workers.dev';
const TOKEN_STORE = path.join(os.homedir(), '.meshare', 'shares.json');

const LIME = s => `\x1b[93m${s}\x1b[0m`;
const DIM = s => `\x1b[2m${s}\x1b[0m`;
const BOLD = s => `\x1b[1m${s}\x1b[0m`;
const RED = s => `\x1b[91m${s}\x1b[0m`;

function usage(code) {
  console.error(`usage: meshare <file> [--name custom-name] [--expires days] [--password secret]
               [--backup] [--no-open] [--port N]
       meshare site <folder> [same flags]   host a small static site P2P
       meshare revoke <fileId>`);
  process.exit(code);
}

// Site bundle format: "MSHARE1\n" + uint32LE manifest length + manifest JSON
// + concatenated file bytes. Every file is SHA-256 hashed so recipients can
// verify integrity before executing anything.
const SITE_MAX_BYTES = 20 * 1024 * 1024;
const SITE_MAX_FILES = 500;

function buildSiteBundle(folderAbs) {
  const files = [];
  (function walk(dir, rel) {
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      if (d.name.startsWith('.') || d.name === 'node_modules') continue;
      const full = path.join(dir, d.name);
      const relPath = rel ? `${rel}/${d.name}` : d.name;
      if (d.isDirectory()) walk(full, relPath);
      else if (d.isFile()) files.push({ full, rel: relPath });
    }
  })(folderAbs, '');
  if (!files.length) { console.error(RED('meshare: folder contains no files')); process.exit(1); }
  if (files.length > SITE_MAX_FILES) { console.error(RED(`meshare: too many files (${files.length} > ${SITE_MAX_FILES})`)); process.exit(1); }
  const entry = files.some(f => f.rel === 'index.html') ? 'index.html'
    : (files.find(f => f.rel.endsWith('.html')) || {}).rel;
  if (!entry) { console.error(RED('meshare: no .html entry file found in folder')); process.exit(1); }
  let offset = 0;
  const manifestFiles = [];
  const datas = [];
  for (const f of files) {
    const buf = fs.readFileSync(f.full);
    manifestFiles.push({
      path: f.rel,
      size: buf.length,
      offset,
      sha256: crypto.createHash('sha256').update(buf).digest('hex')
    });
    datas.push(buf);
    offset += buf.length;
    if (offset > SITE_MAX_BYTES) {
      console.error(RED(`meshare: site exceeds ${SITE_MAX_BYTES / 1048576} MB — keep bundles small (this is v1; chunk-lazy loading is on the roadmap)`));
      process.exit(1);
    }
  }
  const manifest = Buffer.from(JSON.stringify({ kind: 'site', v: 1, entry, files: manifestFiles }));
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32LE(manifest.length);
  const bundle = Buffer.concat([Buffer.from('MSHARE1\n'), lenBuf, manifest, ...datas]);
  const tmp = path.join(os.tmpdir(), `meshare-site-${Date.now()}.mshare`);
  fs.writeFileSync(tmp, bundle);
  return { tmp, fileCount: files.length, totalBytes: bundle.length, entry, siteName: path.basename(folderAbs) };
}

// ── arg parsing ─────────────────────────────────────────────────────────────
const VALUE_FLAGS = new Set(['--name', '--expires', '--password', '--port', '--id']);
const argv = process.argv.slice(2);
const flags = {};
const positional = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (VALUE_FLAGS.has(a)) { flags[a.slice(2)] = argv[++i]; }
  else if (a.startsWith('--')) { flags[a.slice(2)] = true; }
  else positional.push(a);
}

function loadTokens() {
  try { return JSON.parse(fs.readFileSync(TOKEN_STORE, 'utf8')); } catch { return {}; }
}
function saveToken(fileId, record) {
  const all = loadTokens();
  all[fileId] = record;
  fs.mkdirSync(path.dirname(TOKEN_STORE), { recursive: true });
  fs.writeFileSync(TOKEN_STORE, JSON.stringify(all, null, 2));
}

// ── revoke subcommand ───────────────────────────────────────────────────────
if (positional[0] === 'revoke') {
  const id = (positional[1] || '').toLowerCase();
  if (!id) usage(1);
  const record = loadTokens()[id];
  if (!record) {
    console.error(RED(`no owner token stored for "${id}" — this machine didn't create that share (tokens live in ${TOKEN_STORE}).`));
    process.exit(1);
  }
  fetch(`${APP_URL}/api/shares/${id}`, { method: 'DELETE', headers: { 'X-Owner-Token': record.token } })
    .then(async res => {
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      console.log(LIME(`✔ revoked ${id}`) + DIM(' — new downloads disabled, R2 backup deleted. Copies already downloaded cannot be recalled.'));
    })
    .catch(e => { console.error(RED(`revoke failed: ${e.message}`)); process.exit(1); });
  return;
}

// ── share command (file or site bundle) ─────────────────────────────────────
let filePath = positional[0];
let siteInfo = null;
if (positional[0] === 'site') {
  const folder = positional[1];
  if (!folder) usage(1);
  const folderAbs = path.resolve(folder);
  let fstat;
  try { fstat = fs.statSync(folderAbs); } catch { console.error(RED(`meshare: folder not found: ${folderAbs}`)); process.exit(1); }
  if (!fstat.isDirectory()) { console.error(RED(`meshare: not a folder: ${folderAbs}`)); process.exit(1); }
  siteInfo = buildSiteBundle(folderAbs);
  filePath = siteInfo.tmp;
  console.log(DIM(`  site bundle: ${siteInfo.fileCount} files, ${(siteInfo.totalBytes / 1048576).toFixed(2)} MB, entry ${siteInfo.entry} — hash-verified on arrival`));
}
if (!filePath) usage(1);
const absPath = path.resolve(filePath);
let stat;
try { stat = fs.statSync(absPath); } catch { console.error(RED(`meshare: file not found: ${absPath}`)); process.exit(1); }
if (!stat.isFile()) { console.error(RED(`meshare: not a file: ${absPath}`)); process.exit(1); }

const fileName = siteInfo ? `${siteInfo.siteName}.mshare` : path.basename(absPath);
const pwHash = flags.password ? crypto.createHash('sha256').update(String(flags.password)).digest('hex') : null;

async function registerShare() {
  const body = {
    fileName,
    size: stat.size,
    mime: 'application/octet-stream',
    kind: siteInfo ? 'site' : 'file',
    expiresDays: flags.expires !== undefined ? Number(flags.expires) : 7,
    passwordHash: pwHash || undefined
  };
  if (flags.name) body.name = String(flags.name).toLowerCase();
  if (flags.id) body.name = String(flags.id).toLowerCase();
  const res = await fetch(`${APP_URL}/api/shares`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 409) {
    console.error(RED(`✖ the name "${body.name}" is already taken by an active share.`));
    if (data.suggestions) console.error(`  available alternatives: ${data.suggestions.map(LIME).join(', ')}`);
    process.exit(1);
  }
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

async function uploadBackup(fileId, ownerToken) {
  // R2 backup is opt-in via --backup (R2 is off by default, so the normal path stays clean).
  console.log(DIM('  ☁ uploading backup copy to R2…'));
  try {
    const res = await fetch(`${APP_URL}/api/shares/${fileId}/blob`, {
      method: 'PUT',
      headers: { 'X-Owner-Token': ownerToken, 'Content-Length': String(stat.size) },
      body: fs.createReadStream(absPath),
      duplex: 'half'
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    console.log(LIME('  ☁ backup uploaded to R2') + DIM(' — the file stays downloadable even with zero live seeders.'));
  } catch (e) {
    console.error(RED(`  ✖ R2 backup FAILED: ${e.message}`));
    console.error(RED('    the share still works peer-to-peer, but it will NOT survive all seeders going offline.'));
  }
}

let lastStatus = null;
let meta = null;

const server = http.createServer((req, res) => {
  const cors = { 'Access-Control-Allow-Origin': '*' };
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/_seeder') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(fs.readFileSync(path.join(__dirname, 'seeder.html')));
  } else if (url.pathname === '/_meta') {
    res.writeHead(200, { 'Content-Type': 'application/json', ...cors });
    res.end(JSON.stringify(meta));
  } else if (url.pathname === '/_file') {
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': stat.size, ...cors });
    fs.createReadStream(absPath).pipe(res);
  } else if (url.pathname === '/_status' && req.method === 'POST') {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      try { onStatus(JSON.parse(body)); } catch {}
      res.writeHead(204, cors); res.end();
    });
  } else if (url.pathname === '/_status') {
    res.writeHead(200, { 'Content-Type': 'application/json', ...cors });
    res.end(JSON.stringify(lastStatus || { state: 'starting' }));
  } else {
    res.writeHead(404, cors); res.end('not found');
  }
});

function onStatus(s) {
  const prev = lastStatus;
  lastStatus = { ...s, at: Date.now() };
  const line = s.state === 'seeding'
    ? `● seeding (slot ${s.slot}) · ${BOLD(String(s.peers))} peer${s.peers === 1 ? '' : 's'} connected · ${BOLD(String(s.transfers))} transfer${s.transfers === 1 ? '' : 's'} completed`
    : s.state === 'revoked' || s.state === 'expired' ? `✖ share is ${s.state} — seeder stopped`
    : s.state === 'error' ? `✖ seeder error: ${s.message}`
    : `○ ${s.state}…`;
  if (!prev || prev.state !== s.state || prev.peers !== s.peers || prev.transfers !== s.transfers) {
    const bad = ['error', 'revoked', 'expired'].includes(s.state);
    console.log(`${DIM(new Date().toLocaleTimeString())}  ${bad ? RED(line) : LIME(line)}`);
  }
}

function copyToClipboard(text) {
  try {
    const cmd = process.platform === 'win32' ? 'clip'
      : process.platform === 'darwin' ? 'pbcopy' : 'xclip';
    const p = spawn(cmd, process.platform === 'linux' ? ['-selection', 'clipboard'] : [], { stdio: ['pipe', 'ignore', 'ignore'] });
    p.on('error', () => {});
    p.stdin.end(text);
  } catch {}
}

function openBrowser(url) {
  if (process.platform === 'win32') spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
  else if (process.platform === 'darwin') spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
  else spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
}

(async () => {
  let reg;
  try {
    reg = await registerShare();
  } catch (e) {
    if (flags.name || flags.id) {
      console.error(RED(`✖ could not register the custom name (registry error: ${e.message}). Not sharing under an unreserved name — try again or drop --name.`));
      process.exit(1);
    }
    console.error(RED(`registry unreachable (${e.message}) — sharing in legacy mode: random ID, no expiry/revocation/backup.`));
    const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
    reg = {
      fileId: Array.from(crypto.randomBytes(8), b => ALPHABET[b % ALPHABET.length]).join(''),
      ownerToken: null,
      expiresAt: null,
      link: null,
      legacy: true
    };
  }

  const fileId = reg.fileId;
  const link = `${APP_URL}/#${fileId}`;
  if (reg.ownerToken) saveToken(fileId, { token: reg.ownerToken, name: fileName, link, createdAt: new Date().toISOString() });

  meta = { fileId, name: fileName, size: stat.size, link, pwHash, apiBase: APP_URL, legacy: !!reg.legacy };

  const port = Number(flags.port) || 0;
  server.listen(port, '127.0.0.1', () => {
    const p = server.address().port;
    const seederUrl = `http://localhost:${p}/_seeder`;
    console.log('');
    console.log(`  ${BOLD('meshare')} ${DIM('·')} sharing ${BOLD(fileName)} ${DIM(`(${(stat.size / 1048576).toFixed(1)} MB)`)}`);
    console.log('');
    console.log(`  link  ${LIME(link)}  ${DIM('(copied to clipboard)')}`);
    console.log(`  id    ${fileId}${flags.password ? DIM('  · password-protected') : ''}`);
    if (reg.expiresAt) console.log(`  ${DIM(`expires ${new Date(reg.expiresAt).toLocaleString()} · revoke anytime: meshare revoke ${fileId}`)}`);
    console.log('');
    qrcode.generate(link, { small: true }, q => console.log(q.replace(/^/gm, '  ')));
    console.log(`  ${DIM('keep this running — the browser tab it opens is the seeder.')}`);
    console.log('');
    copyToClipboard(link);
    if (reg.ownerToken && flags.backup) uploadBackup(fileId, reg.ownerToken);
    if (!flags['no-open']) openBrowser(seederUrl);
    else console.log(`  ${DIM(`--no-open: open ${seederUrl} yourself to start seeding.`)}`);
  });
})();

process.on('SIGINT', () => {
  console.log(`\n  ${DIM('stopped. the file stays available while any other seeder is online (or from the R2 backup).')}`);
  process.exit(0);
});
