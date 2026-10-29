// Bemor.Flow runner (side panel): applies one prompt to every image in a folder through Google Flow and
// saves the results under names built from patterns.
const DEFAULT_PROMPT =
  '{base}_edit: Edit this image. Keep the same subject, framing and background. ' +
  'Describe the change you want here.';

// Name patterns. Tokens: {base} = source file name without extension, {i} = position in this run (01, 02...),
// {date} = YYYYMMDD. A "/" makes a subfolder. The extension comes from the image Flow returns.
const DEFAULTS = { name1: '{base}', name2: 'alt/{base}_b' };

const $ = (id) => document.getElementById(id);
let inDir = null, outDir = null, stopFlag = false, running = false;

function load(key, def) { try { return localStorage.getItem(key) ?? def; } catch (e) { return def; } }
function keep(key, val) { try { localStorage.setItem(key, val); } catch (e) { /* storage off */ } }
// gw-prompt is the key older versions used, so a saved prompt carries over
$('prompt').value = load('gw-prompt', DEFAULT_PROMPT);
$('prompt').addEventListener('input', () => keep('gw-prompt', $('prompt').value));
for (const k of ['name1', 'name2']) {
  $(k).value = load('bf-' + k, DEFAULTS[k]);
  $(k).addEventListener('input', () => { keep('bf-' + k, $(k).value); preview(); });
}

function log(msg, cls) {
  const d = document.createElement('div');
  if (cls) d.className = cls;
  d.textContent = new Date().toLocaleTimeString() + '  ' + msg;
  $('log').appendChild(d);
  $('log').scrollTop = $('log').scrollHeight;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
chrome.runtime.onMessage.addListener((m) => { if (m && m.cmd === 'progress') log('   ' + m.text); });
function refresh() { $('start').disabled = !(inDir && outDir) || running; $('stop').disabled = !running; }

$('pickIn').onclick = async () => {
  try { inDir = await showDirectoryPicker({ mode: 'read' }); $('inInfo').textContent = inDir.name; $('inInfo').classList.add('set'); } catch (e) { /* cancelled */ }
  refresh();
};
$('pickOut').onclick = async () => {
  try { outDir = await showDirectoryPicker({ mode: 'readwrite' }); $('outInfo').textContent = outDir.name; $('outInfo').classList.add('set'); } catch (e) { /* cancelled */ }
  refresh();
};
$('stop').onclick = () => { stopFlag = true; log('Stop requested; finishing the current image...'); };

const today = () => new Date().toISOString().slice(0, 10).replace(/-/g, '');
function applyName(pattern, base, i) {
  return pattern.trim()
    .split('{base}').join(base)
    .split('{i}').join(String(i).padStart(2, '0'))
    .split('{date}').join(today())
    .replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
}
const extFor = (type) => (/png/i.test(type) ? '.png' : /webp/i.test(type) ? '.webp' : '.jpg');
function preview() {
  const a = $('name1').value.trim() ? applyName($('name1').value, 'my_photo', 1) + '.jpg' : '(not saved)';
  const b = $('name2').value.trim() ? applyName($('name2').value, 'my_photo', 1) + '.jpg' : '(not saved)';
  $('namePreview').textContent = `my_photo.png → ${a}  +  ${b}`;
}
preview();

async function listJobs() {
  let map = {};
  try { map = await (await fetch(chrome.runtime.getURL('renamemap.json'))).json(); } catch (e) { /* optional */ }
  const jobs = [];
  for await (const [name, handle] of inDir.entries()) {
    if (handle.kind !== 'file' || !/\.(jpe?g|png|webp)$/i.test(name)) continue;
    const clean = map[name] || name;          // optional renamemap.json: source name -> preferred name
    jobs.push({ srcName: name, base: clean.replace(/\.[^.]+$/, ''), handle });
  }
  jobs.sort((a, b) => a.base.localeCompare(b.base, undefined, { numeric: true }));
  return jobs;
}

// walk/create subfolders in an "a/b/name" path; returns [dirHandle, fileName]
async function resolve(dir, path, create) {
  const parts = path.split('/').filter(Boolean);
  const file = parts.pop();
  for (const p of parts) dir = await dir.getDirectoryHandle(p, { create });
  return [dir, file];
}
async function existsAny(dir, stemPath) {
  try {
    const [d, stem] = await resolve(dir, stemPath, false);
    for (const ext of ['.jpg', '.png', '.webp', '.jpeg']) {
      try { await d.getFileHandle(stem + ext); return true; } catch (e) { /* try next */ }
    }
  } catch (e) { /* folder missing */ }
  return false;
}
async function save(dir, path, b64) {
  const bin = atob(b64), u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  const [d, name] = await resolve(dir, path, true);
  const fh = await d.getFileHandle(name, { create: true });
  const w = await fh.createWritable();
  await w.write(u);
  await w.close();
}
function fileB64(file) {
  return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.onerror = rej; r.readAsDataURL(file); });
}
async function flowTab() {
  const tabs = await chrome.tabs.query({ url: 'https://flow.google.com/project/*' });
  return tabs.find((t) => t.active) || tabs[0];
}
async function waitReady(tabId, timeout = 60000) {
  const t = Date.now();
  while (Date.now() - t < timeout) {
    try { const r = await chrome.tabs.sendMessage(tabId, { cmd: 'ping' }); if (r && r.ready) return; } catch (e) { /* not loaded yet */ }
    await sleep(1000);
  }
  throw new Error('Flow page did not become ready');
}

$('start').onclick = async () => {
  running = true; stopFlag = false; refresh();
  let done = 0, failed = 0;
  const failedNames = [];
  const p1 = $('name1').value, p2 = $('name2').value;
  try {
    if (!p1.trim()) throw new Error('Give image 1 a name pattern, e.g. {base}');
    let jobs = await listJobs();
    const only = $('only').value.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    if (only.length) jobs = jobs.filter((j) => only.some((o) => j.base.toLowerCase().includes(o)));
    jobs.forEach((j, i) => { j.out1 = applyName(p1, j.base, i + 1); j.out2 = p2.trim() ? applyName(p2, j.base, i + 1) : ''; });
    if ($('skip').checked) {
      const kept = [];
      for (const j of jobs) if (!(await existsAny(outDir, j.out1))) kept.push(j);
      log(`${jobs.length - kept.length} already done, skipped.`);
      jobs = kept;
    }
    const limit = Math.max(1, parseInt($('limit').value, 10) || 1);
    jobs = jobs.slice(0, limit);
    log(`${jobs.length} image(s) to do.`);
    const tab = await flowTab();
    if (!tab) throw new Error('Open your Flow project (flow.google.com/project/...) in a tab first.');
    for (const [i, job] of jobs.entries()) {
      if (stopFlag) break;
      $('status').textContent = `${i + 1}/${jobs.length}  ${job.base}`;
      const tries = 1 + Math.max(0, parseInt($('retries').value, 10) || 0);
      for (let attempt = 1; attempt <= tries; attempt++) {
      try {
        log(`${job.base}: preparing...${attempt > 1 ? ` (retry ${attempt - 1} of ${tries - 1})` : ''}`);
        await chrome.tabs.reload(tab.id);          // fresh prompt box: no leftover ingredient
        await sleep(2500);
        await waitReady(tab.id);
        const file = await job.handle.getFile();
        const res = await chrome.tabs.sendMessage(tab.id, {
          cmd: 'run',
          job: {
            // unique per run: an older upload with the same name would otherwise be picked instead of the new one
            name: job.base + '_src_' + Date.now().toString(36) + '.jpg',
            mime: file.type || 'image/jpeg',
            b64: await fileB64(file),
            prompt: $('prompt').value.split('{base}').join(job.base),
            count: job.out2 ? 2 : 1,
            timeout: (parseInt($('tmo').value, 10) || 240) * 1000,
          },
        });
        if (!res || !res.ok) throw new Error(res ? res.error : 'no answer from the Flow tab');
        const n1 = job.out1 + extFor(res.images[0].type);
        await save(outDir, n1, res.images[0].b64);
        let n2 = '';
        if (job.out2 && res.images[1]) {
          n2 = job.out2 + extFor(res.images[1].type);
          await save(outDir, n2, res.images[1].b64);
        }
        done++;
        log(`${job.base}: saved ${n1}${n2 ? ' + ' + n2 : ''}`, 'ok');
        break;
      } catch (e) {
        const last = attempt >= tries || stopFlag;
        log(`${job.base}: ${last ? 'FAILED' : 'failed, will retry'} - ${e.message}`, 'err');
        if (last) { failed++; failedNames.push(job.base); break; }
        await sleep(5000);                         // let Flow settle before the retry
      }
      }
      if (i < jobs.length - 1 && !stopFlag) await sleep((parseInt($('pause').value, 10) || 0) * 1000);
    }
  } catch (e) {
    log('Error: ' + e.message, 'err');
  }
  log(`Finished. ${done} saved, ${failed} failed.`, failed ? 'err' : 'ok');
  if (failedNames.length) {
    log('To redo only the failures, paste this into "Only names containing": ' + failedNames.join(', '), 'err');
  }
  $('status').textContent = '';
  running = false; refresh();
};

// ---- log tools: download / copy / clear, for bug reports ----
function logText() {
  const m = chrome.runtime.getManifest();
  const head = [
    `${m.name} ${m.version} log`,
    `Saved: ${new Date().toString()}`,
    `Browser: ${navigator.userAgent}`,
    `Settings: images=${$('limit').value} cooldown=${$('pause').value}s giveUp=${$('tmo').value}s retries=${$('retries').value} skip=${$('skip').checked}`,
    `Naming: image1="${$('name1').value}" image2="${$('name2').value}" only="${$('only').value}"`,
    `Prompt: ${$('prompt').value}`,
    '-'.repeat(60),
  ];
  return head.concat([...$('log').children].map((d) => d.textContent)).join('\n') + '\n';
}
$('dlLog').onclick = () => {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([logText()], { type: 'text/plain' }));
  a.download = `bemor-flow-log-${stamp}.txt`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
};
$('copyLog').onclick = async () => {
  try { await navigator.clipboard.writeText(logText()); $('copyLog').textContent = 'Copied!'; }
  catch (e) { $('copyLog').textContent = 'Copy failed'; }
  setTimeout(() => { $('copyLog').textContent = 'Copy log'; }, 1500);
};
$('clearLog').onclick = () => { if (!running) $('log').textContent = ''; };
