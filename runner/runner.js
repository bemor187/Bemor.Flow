#!/usr/bin/env node
// Bemor.Flow runner: serves a job file to the Bemor.Flow extension (job mode) on 127.0.0.1 only,
// paces the jobs, saves the images the extension sends back, optionally runs a checker on them,
// and records every state change in results.json. No dependencies beyond Node itself.
//
//   node runner.js --jobs jobs.json [--port 8787] [--out DIR] [--gap 20-60] [--check "CMD"]
//                  [--job-timeout 900] [--redo] [--mock] [--mock-block signin|captcha|quota|ui-changed]
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { execFile } = require('child_process');

const VERSION = '0.1.0';
const HOST = '127.0.0.1';
const BLOCKS = ['signin', 'captcha', 'quota', 'ui-changed', 'setup'];
const MAX_FAILS = 3;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,80}$/;

// ---------------------------------------------------------------- options
function parseArgs(argv) {
  const o = { port: 8787, gap: [20, 60], jobTimeout: 900, mock: false, mockBlock: null, redo: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], v = () => { if (i + 1 >= argv.length) die(`${a} needs a value`); return argv[++i]; };
    if (a === '--jobs') o.jobs = v();
    else if (a === '--port') o.port = parseInt(v(), 10);
    else if (a === '--out') o.out = v();
    else if (a === '--gap') {
      const m = /^(\d+(?:\.\d+)?)(?:-(\d+(?:\.\d+)?))?$/.exec(v());
      if (!m) die('--gap wants seconds, e.g. 20-60 or 0.2-0.5');
      o.gap = [parseFloat(m[1]), parseFloat(m[2] || m[1])];
    } else if (a === '--check') o.check = v();
    else if (a === '--job-timeout') o.jobTimeout = parseFloat(v());
    else if (a === '--redo') o.redo = true;
    else if (a === '--mock') o.mock = true;
    else if (a === '--mock-block') { o.mockBlock = v(); o.mock = true; }
    else if (a === '-h' || a === '--help') { console.log(fs.readFileSync(path.join(__dirname, 'README.md'), 'utf8')); process.exit(0); }
    else die('unknown option ' + a);
  }
  if (!o.jobs) die('usage: node runner.js --jobs jobs.json [--port 8787] [--out DIR] [--gap 20-60] [--check "CMD"] [--mock]');
  if (!(o.port > 0 && o.port < 65536)) die('bad --port');
  if (o.mockBlock && !BLOCKS.includes(o.mockBlock)) die('--mock-block must be one of ' + BLOCKS.join(', '));
  return o;
}
function die(msg) { console.error('runner: ' + msg); process.exit(64); }
const now = () => new Date().toISOString();
const log = (msg) => console.log(`${new Date().toISOString().slice(11, 19)}  ${msg}`);

// ---------------------------------------------------------------- job file + results
function loadJobs(file, outOverride) {
  const spec = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(spec.jobs) || !spec.jobs.length) die('jobs.json has no "jobs"');
  const base = path.dirname(path.resolve(file));
  const outDir = path.resolve(base, outOverride || spec.out_dir || 'out');
  const seen = new Set();
  const jobs = spec.jobs.map((j) => {
    if (!NAME_RE.test(j.name || '')) die(`bad job name ${JSON.stringify(j.name)} (letters, digits, _ . -)`);
    if (seen.has(j.name)) die('duplicate job name ' + j.name);
    seen.add(j.name);
    if (!j.prompt) die(`job ${j.name} has no prompt`);
    const inputs = (j.inputs || []).map((p) => path.resolve(base, p));
    for (const p of inputs) if (!fs.existsSync(p)) die(`job ${j.name}: input not found: ${p}`);
    return {
      name: j.name, prompt: String(j.prompt), count: Math.max(1, Math.min(4, j.count | 0 || 2)),
      inputs, kind: j.kind || 'tile', seamless: j.seamless || 'none', size: j.size || null,
    };
  });
  return { set: spec.set || path.basename(file, '.json'), outDir, jobs };
}

class Results {
  constructor(file, set, jobs, prev, redo) {
    this.file = file;
    this.data = { set, runner: VERSION, started: now(), updated: now(), run_state: 'running', jobs: [] };
    const old = new Map(((prev && prev.jobs) || []).map((j) => [j.name, j]));
    for (const j of jobs) {
      const o = old.get(j.name);
      if (o && o.state === 'delivered' && !redo) {
        this.data.jobs.push(Object.assign({}, o, { skipped: 'delivered in an earlier run (use --redo)' }));
      } else {
        this.data.jobs.push({ name: j.name, state: 'queued', detail: '', files: [], history: [{ state: 'queued', at: now() }] });
      }
    }
  }
  get(name) { return this.data.jobs.find((j) => j.name === name); }
  set(name, state, detail, extra) {
    const r = this.get(name);
    r.state = state;
    r.detail = detail || '';
    Object.assign(r, extra || {});
    r.history.push(Object.assign({ state, at: now() }, detail ? { detail } : {}));
    log(`${name}: ${state}${detail ? ' (' + detail + ')' : ''}`);
    this.save();
  }
  save() {
    this.data.updated = now();
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 1));
    fs.renameSync(tmp, this.file);
  }
}

// keep the previous version of any file we are about to replace
function moveToOld(outDir, file) {
  if (!fs.existsSync(file)) return null;
  const oldDir = path.join(outDir, '_old');
  fs.mkdirSync(oldDir, { recursive: true });
  const ext = path.extname(file), stem = path.basename(file, ext);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(oldDir, `${stem}_${stamp}${ext}`);
  fs.renameSync(file, dest);
  return dest;
}

// "python -I artcheck.py check {file} --seamless {seamless}" -> argv, honouring "double quotes"
function splitCmd(s) {
  const out = []; let cur = '', q = false, any = false;
  for (const ch of s) {
    if (ch === '"') { q = !q; any = true; } else if (!q && /\s/.test(ch)) { if (any) out.push(cur); cur = ''; any = false; } else { cur += ch; any = true; }
  }
  if (any) out.push(cur);
  return out;
}
function runCheck(tmpl, job, file) {
  const args = splitCmd(tmpl).map((a) => a.split('{file}').join(file).split('{seamless}').join(job.seamless)
    .split('{size}').join(String(job.size || '')).split('{name}').join(job.name));
  // drop "--size" with an empty value when the job has no size
  for (let i = args.length - 2; i >= 0; i--) if (args[i] === '--size' && args[i + 1] === '') args.splice(i, 2);
  return new Promise((res) => {
    execFile(args[0], args.slice(1), { timeout: 120000, windowsHide: true, maxBuffer: 4 << 20 }, (err, stdout) => {
      let info = null;
      try { info = JSON.parse(stdout); } catch (e) { /* not JSON */ }
      const pass = !err;
      const reasons = info && Array.isArray(info.reasons) ? info.reasons : [];
      let score = info && typeof info.score === 'number' ? info.score : null;
      if (score === null && info && info.seam) score = (info.seam.lr || 0) + (info.seam.tb || 0);
      res({ file: path.basename(file), pass, reasons: pass ? [] : (reasons.length ? reasons : [String(err && err.message || 'checker failed').slice(0, 200)]), score });
    });
  });
}

// ---------------------------------------------------------------- the runner
function main() {
  const opt = parseArgs(process.argv.slice(2));
  const { set, outDir, jobs } = loadJobs(opt.jobs, opt.out);
  fs.mkdirSync(path.join(outDir, '_candidates'), { recursive: true });
  const resFile = path.join(outDir, 'results.json');
  let prev = null;
  try { prev = JSON.parse(fs.readFileSync(resFile, 'utf8')); } catch (e) { /* first run */ }
  const results = new Results(resFile, set, jobs, prev, opt.redo);
  if (prev) moveToOld(outDir, resFile);
  results.save();
  const manifestFile = path.join(outDir, 'manifest.json');
  let manifest = {};
  try { manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')); } catch (e) { /* none yet */ }
  const saveManifest = () => { fs.writeFileSync(manifestFile + '.tmp', JSON.stringify(manifest, null, 1)); fs.renameSync(manifestFile + '.tmp', manifestFile); };

  let current = null;          // { job, since, lastSeen }
  let nextAt = 0;              // earliest time the next job may start (pacing)
  let fails = 0;
  let finished = null;         // final run_state once stopped
  const byName = new Map(jobs.map((j) => [j.name, j]));
  const pending = () => results.data.jobs.filter((r) => r.state === 'queued').map((r) => byName.get(r.name));

  function finish(state) {
    if (finished) return;
    finished = state;
    results.data.run_state = state;
    const count = (st) => results.data.jobs.filter((r) => r.state.startsWith(st)).length;
    results.data.summary = { delivered: count('delivered'), check_failed: count('checked'), failed: count('failed'), blocked: count('blocked'), queued: count('queued') };
    results.save();
    log('summary ' + JSON.stringify(results.data.summary));
    log(`run ${state}. results: ${resFile}`);
    if (state.startsWith('blocked')) log('All Flow jobs are paused. A person has to look at the Flow tab before the next run.');
    // let the client read {done} once, then exit
    setTimeout(() => { server.close(); if (mockTimer) clearTimeout(mockTimer); process.exitCode = state === 'done' ? 0 : state.startsWith('blocked') ? 2 : 3; }, 1500);
  }
  function jobEnded(ok) {
    current = null;
    fails = ok ? 0 : fails + 1;
    const [a, b] = opt.gap;
    nextAt = Date.now() + Math.round((a + Math.random() * (b - a)) * 1000);
    if (fails >= MAX_FAILS) return finish(`stopped: ${MAX_FAILS} consecutive failures`);
    if (!pending().length) finish('done');
  }

  async function onDownloaded(job, files) {
    const saved = [];
    const cand = path.join(outDir, '_candidates');
    for (const [i, f] of files.entries()) {
      if (!f || !f.b64) continue;
      const k = Number.isInteger(f.k) && f.k > 0 && f.k < 100 ? f.k : i + 1;
      const ext = /png/i.test(f.type || 'image/png') ? '.png' : /webp/i.test(f.type) ? '.webp' : '.jpg';
      const file = path.join(cand, `${job.name}_${k}${ext}`);
      moveToOld(outDir, file);
      fs.writeFileSync(file, Buffer.from(f.b64, 'base64'));
      saved.push(file);
    }
    if (!saved.length) { results.set(job.name, 'failed', 'downloaded state without images'); return jobEnded(false); }
    results.set(job.name, 'downloaded', `${saved.length} image(s)`, { files: saved.map((f) => path.relative(outDir, f).split(path.sep).join('/')) });
    // check
    let checks;
    if (opt.check) checks = await Promise.all(saved.map((f) => runCheck(opt.check, job, f)));
    else checks = saved.map((f) => ({ file: path.basename(f), pass: true, reasons: ['no checker configured'], score: null }));
    const passing = checks.map((c, i) => ({ c, f: saved[i] })).filter((x) => x.c.pass);
    if (!passing.length) {
      results.set(job.name, 'checked', 'fail: ' + checks.map((c) => `${c.file}: ${c.reasons.join('; ')}`).join(' | '), { checks });
      manifest[job.name] = { prompt: job.prompt, attempts: ((manifest[job.name] || {}).attempts || 0) + 1, chosen: null, checks, date: now() };
      saveManifest();
      return jobEnded(false);
    }
    passing.sort((x, y) => (x.c.score ?? 0) - (y.c.score ?? 0));
    const best = passing[0];
    results.set(job.name, 'checked', `pass: ${passing.length}/${checks.length}, best ${path.basename(best.f)}${opt.check ? '' : ' (no checker configured)'}`, { checks });
    const dest = path.join(outDir, job.name + path.extname(best.f));
    const old = moveToOld(outDir, dest);
    fs.copyFileSync(best.f, dest);
    results.set(job.name, 'delivered', path.basename(dest) + (old ? `; previous kept as _old/${path.basename(old)}` : ''), { delivered: path.basename(dest) });
    manifest[job.name] = { prompt: job.prompt, attempts: ((manifest[job.name] || {}).attempts || 0) + 1, chosen: path.basename(best.f), checks, date: now() };
    saveManifest();
    jobEnded(true);
  }

  async function onStatus(b) {
    const job = byName.get(b.name);
    if (!job) return { status: 404, body: { error: 'unknown job ' + b.name } };
    if (!current || current.job !== job) return { status: 409, body: { error: 'not the running job' } };
    current.lastSeen = Date.now();
    let state = String(b.state || '');
    let detail = String(b.detail || '').slice(0, 2000);
    const m = /^blocked(?::\s*(.+))?$/.exec(state);
    if (m) {
      const kind = (m[1] || detail.split(/[\s:]/)[0] || '').trim();
      if (!BLOCKS.includes(kind)) return { status: 400, body: { error: 'blocked kind must be one of ' + BLOCKS.join(', ') } };
      results.set(job.name, 'blocked: ' + kind, detail.replace(new RegExp('^' + kind + '\\s*:?\\s*'), ''));
      current = null;
      finish('blocked: ' + kind);
      return { body: { ok: true, stop: true } };
    }
    if (state === 'running' || state === 'progress') {
      if (state === 'running') results.set(job.name, 'running', detail);
      else log(`${job.name}:   ${detail}`);
      return { body: { ok: true } };
    }
    if (state === 'downloaded') { await onDownloaded(job, Array.isArray(b.files) ? b.files : []); return { body: { ok: true, state: results.get(job.name).state } }; }
    if (state === 'failed') { results.set(job.name, 'failed', detail || 'client reported failure'); jobEnded(false); return { body: { ok: true } }; }
    return { status: 400, body: { error: 'unknown state ' + state } };
  }

  function onNext() {
    if (finished) return { done: true, run_state: finished };
    if (current) return { wait: 5000, running: current.job.name };
    const left = pending();
    if (!left.length) { finish('done'); return { done: true, run_state: 'done' }; }
    const wait = nextAt - Date.now();
    if (wait > 0) return { wait };
    const job = left[0];
    current = { job, since: Date.now(), lastSeen: Date.now() };
    log(`${job.name}: handed to the client`);
    return {
      job: {
        name: job.name, prompt: job.prompt, count: job.count, kind: job.kind, seamless: job.seamless, size: job.size,
        inputs: job.inputs.map((p, i) => ({ i, file: path.basename(p), url: `/input?name=${encodeURIComponent(job.name)}&i=${i}` })),
        timeout: Math.round(opt.jobTimeout * 1000 * 0.8),
      },
    };
  }

  // jobs whose client went quiet
  const watchdog = setInterval(() => {
    if (current && Date.now() - current.lastSeen > opt.jobTimeout * 1000) {
      const n = current.job.name;
      results.set(n, 'failed', `no status from the client for ${opt.jobTimeout} s`);
      jobEnded(false);
    }
  }, 5000);
  watchdog.unref();

  // ------------------------------------------------------------ HTTP
  const send = (res, status, body) => {
    const s = JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(s);
  };
  const server = http.createServer((req, res) => {
    // Only this machine: bound to 127.0.0.1, Host must be the loopback name (no DNS rebinding),
    // and browser requests are accepted only from extensions, never from web pages.
    const host = String(req.headers.host || '');
    const origin = req.headers.origin;
    if (!new RegExp(`^(127\\.0\\.0\\.1|localhost):${opt.port}$`).test(host)) return send(res, 403, { error: 'bad host' });
    if (origin && !/^chrome-extension:\/\//.test(origin)) return send(res, 403, { error: 'origin not allowed' });
    const url = new URL(req.url, `http://${HOST}:${opt.port}`);
    if (req.method === 'GET' && url.pathname === '/hello') return send(res, 200, { app: 'bemor-flow-runner', version: VERSION, set, run_state: finished || 'running' });
    if (req.method === 'GET' && url.pathname === '/next') return send(res, 200, onNext());
    if (req.method === 'GET' && url.pathname === '/results') return send(res, 200, results.data);
    if (req.method === 'GET' && url.pathname === '/input') {
      const job = byName.get(url.searchParams.get('name') || '');
      const p = job && job.inputs[parseInt(url.searchParams.get('i'), 10)];
      if (!p) return send(res, 404, { error: 'no such input' });
      const ext = path.extname(p).toLowerCase();
      res.writeHead(200, { 'Content-Type': ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg', 'X-File-Name': path.basename(p) });
      return fs.createReadStream(p).pipe(res);
    }
    if (req.method === 'POST' && url.pathname === '/status') {
      if (!/application\/json/.test(req.headers['content-type'] || '')) return send(res, 415, { error: 'JSON only' });
      const chunks = []; let size = 0;
      req.on('data', (c) => { size += c.length; if (size > 64 << 20) { req.destroy(); } else chunks.push(c); });
      req.on('end', async () => {
        let b;
        try { b = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) { return send(res, 400, { error: 'bad JSON' }); }
        try { const r = await onStatus(b); send(res, r.status || 200, r.body); } catch (e) { send(res, 500, { error: String(e.message || e) }); }
      });
      return undefined;
    }
    return send(res, 404, { error: 'not found' });
  });
  let mockTimer = null;
  server.on('error', (e) => die(`cannot listen on ${HOST}:${opt.port}: ${e.message}`));
  server.listen(opt.port, HOST, () => {
    log(`Bemor.Flow runner ${VERSION} on http://${HOST}:${opt.port}  set "${set}", ${pending().length} job(s) queued, out ${outDir}`);
    log(`pacing ${opt.gap[0]}-${opt.gap[1]} s between jobs, stop after ${MAX_FAILS} consecutive failures${opt.check ? ', checker on' : ''}`);
    if (!pending().length) finish('done');
    else if (opt.mock) mockClient(opt, (t) => { mockTimer = t; });
    else log('waiting for Bemor.Flow job mode (side panel > Job mode > Start)...');
  });
}

// ---------------------------------------------------------------- mock client
// A fake extension: polls /next, "generates" small synthetic PNGs and reports like job mode does.
function tinyPng(seed) {
  const w = 32, h = 32, raw = Buffer.alloc(h * (w * 3 + 1));
  let s = seed >>> 0;
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w * 3; x++) { s = (s * 1103515245 + 12345) >>> 0; raw[y * (w * 3 + 1) + 1 + x] = 96 + ((s >>> 16) & 63); }
  }
  const crcT = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; crcT[n] = c >>> 0; }
  const crc = (b) => { let c = 0xFFFFFFFF; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
  const chunk = (type, data) => { const t = Buffer.from(type), len = Buffer.alloc(4), c = Buffer.alloc(4); len.writeUInt32BE(data.length); c.writeUInt32BE(crc(Buffer.concat([t, data]))); return Buffer.concat([len, t, data, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
function mockClient(opt, keepTimer) {
  const base = `http://${HOST}:${opt.port}`;
  const post = (b) => fetch(base + '/status', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then((r) => r.json());
  const sleep = (ms) => new Promise((r) => { keepTimer(setTimeout(r, ms)); });
  let n = 0;
  (async () => {
    log('[mock] fake client started' + (opt.mockBlock ? ` (will report blocked: ${opt.mockBlock})` : ''));
    for (;;) {
      let r;
      try { r = await (await fetch(base + '/next')).json(); } catch (e) { log('[mock] runner gone'); return; }
      if (r.done) { log(`[mock] runner says done (${r.run_state})`); return; }
      if (r.wait) { await sleep(Math.min(r.wait, 1000)); continue; }
      const job = r.job; n++;
      await post({ name: job.name, state: 'running', detail: job.inputs.length ? 'image-to-image' : 'text-to-image' });
      await sleep(150);
      if (opt.mockBlock) {
        const msg = { signin: 'Flow redirected to accounts.google.com', captcha: 'page shows "unusual traffic" / reCAPTCHA frame',
          quota: 'page says out of credits', 'ui-changed': 'prompt box not found', setup: 'no Flow project tab open' }[opt.mockBlock];
        log('[mock] ' + JSON.stringify(await post({ name: job.name, state: 'blocked: ' + opt.mockBlock, detail: msg })));
        continue;
      }
      await post({ name: job.name, state: 'progress', detail: 'prompt typed; generate clicked' });
      await sleep(200);
      const files = [];
      for (let k = 1; k <= job.count; k++) files.push({ k, type: 'image/png', b64: tinyPng(n * 100 + k).toString('base64') });
      await post({ name: job.name, state: 'downloaded', files });
    }
  })().catch((e) => log('[mock] error ' + e.message));
}

main();
