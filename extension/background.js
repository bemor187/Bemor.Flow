// The runner lives in Chrome's side panel so the Flow tab stays in front next to it.
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});
chrome.runtime.onStartup.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});

// Flow only accepts a *trusted* click on its generate button (a script-made click is ignored), so the
// page asks us to send a real mouse click through the debugger protocol. Chrome shows its
// "started debugging this browser" bar for the moment it is attached.
chrome.runtime.onMessage.addListener((msg, sender, send) => {
  if (msg && msg.cmd === 'focus-tab' && sender.tab) {
    chrome.tabs.update(sender.tab.id, { active: true })
      .then(() => chrome.windows.update(sender.tab.windowId, { focused: true }))
      .then(() => send({ ok: true }), () => send({ ok: false }));
    return true;
  }
  if (!msg || msg.cmd !== 'trusted-click' || !sender.tab) return;
  const target = { tabId: sender.tab.id };
  (async () => {
    try {
      await chrome.tabs.update(sender.tab.id, { active: true });
      try { await chrome.debugger.attach(target, '1.3'); } catch (e) {
        if (!String(e).includes('already attached')) throw e;
      }
      for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
        await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', {
          type, x: msg.x, y: msg.y, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1,
        });
      }
      send({ ok: true });
    } catch (e) {
      send({ ok: false, error: String(e && e.message || e) });
    } finally {
      try { await chrome.debugger.detach(target); } catch (e) { /* not attached */ }
    }
  })();
  return true;
});

// ---------------------------------------------------------------------------------------------
// Job mode: take jobs from a local Bemor.Flow runner (runner/runner.js on 127.0.0.1), run each one
// on the open Flow project tab, and send the images back to the runner, which saves them.
// It only reads the page to notice sign-in, CAPTCHA, quota or layout problems; when it sees one it
// reports "blocked: <kind>" and stops. It never fills in sign-in forms or touches a CAPTCHA.
const JM = { active: false, stop: false, port: 8787, state: 'off', job: '' };
const jmSleep = (ms) => new Promise((r) => setTimeout(r, ms));
function jmSay(text) {
  chrome.runtime.sendMessage({ cmd: 'progress', text: '[job mode] ' + text }).catch(() => { /* panel closed */ });
}
function jmState(state, job) {
  JM.state = state; JM.job = job || '';
  chrome.runtime.sendMessage({ cmd: 'job-state', active: JM.active, state, job: JM.job, port: JM.port }).catch(() => {});
}

// Pages that mean "a person must look": Google sign-in, Google's "unusual traffic" page.
// Only the kind is reported, never the address (it can carry account details).
function urlBlock(url) {
  if (/^https:\/\/accounts\.google\.com\//.test(url || '')) return { kind: 'signin', detail: 'tab is on the Google sign-in page' };
  if (/^https:\/\/(www\.)?google\.[a-z.]+\/sorry\//.test(url || '') || /recaptcha/i.test(url || '')) {
    return { kind: 'captcha', detail: 'tab is on a Google "unusual traffic" / reCAPTCHA page' };
  }
  return null;
}
async function pageBlock(tabId) {
  try {
    const t = await chrome.tabs.get(tabId);
    const u = urlBlock(t.url);
    if (u) return u;
    const r = await chrome.tabs.sendMessage(tabId, { cmd: 'detect' });
    return r && r.blocked ? r.blocked : null;
  } catch (e) { return null; }
}
async function jmFlowTab() {
  const tabs = await chrome.tabs.query({ url: 'https://flow.google.com/project/*' });
  const tab = tabs.find((t) => t.active) || tabs[0];
  if (tab) return { tab };
  // a sign-in / check page counts only if it belongs to Flow (on Flow, or its continue= link points back there)
  for (const t of await chrome.tabs.query({})) {
    if (!/flow\.google\.com|labs\.google/.test(t.url || '')) continue;
    const b = urlBlock(t.url); if (b) return { blocked: b };
  }
  const other = (await chrome.tabs.query({ url: 'https://flow.google.com/*' }))[0];
  if (other) {
    const b = await pageBlock(other.id);
    if (b) return { blocked: b };
  }
  return { blocked: { kind: 'setup', detail: 'no Flow project tab open (flow.google.com/project/...)' } };
}
async function jmWaitReady(tabId, timeout = 60000) {
  const t = Date.now();
  while (Date.now() - t < timeout) {
    try { const r = await chrome.tabs.sendMessage(tabId, { cmd: 'ping' }); if (r && r.ready) return true; } catch (e) { /* loading */ }
    if (await pageBlock(tabId)) return false;
    await jmSleep(1000);
  }
  return false;
}
function blobB64(blob) {
  return blob.arrayBuffer().then((buf) => {
    const u = new Uint8Array(buf); let s = '';
    for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
    return btoa(s);
  });
}

async function jmRunJob(base, job) {
  const post = (b) => fetch(base + '/status', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) })
    .then((r) => r.json()).catch((e) => ({ error: String(e) }));
  const blocked = async (b) => {
    jmSay(`${job.name}: BLOCKED (${b.kind}): ${b.detail}. Job mode stops; a person has to look at the Flow tab.`);
    await post({ name: job.name, state: 'blocked: ' + b.kind, detail: b.detail });
    return 'blocked';
  };
  const mode = job.inputs && job.inputs.length ? 'image-to-image' : 'text-to-image';
  jmState('running', job.name);
  jmSay(`${job.name}: ${mode}, ${job.count} image(s)`);
  await post({ name: job.name, state: 'running', detail: mode });
  const found = await jmFlowTab();
  if (found.blocked) return blocked(found.blocked);
  const tab = found.tab;
  let b = await pageBlock(tab.id);
  if (b) return blocked(b);
  await chrome.tabs.reload(tab.id);                 // fresh prompt box: no leftover ingredient
  await jmSleep(2500);
  if (!(await jmWaitReady(tab.id))) {
    return blocked((await pageBlock(tab.id)) || { kind: 'ui-changed', detail: 'Flow prompt box not found within 60 s' });
  }
  const run = { prompt: job.prompt, count: job.count || 2, timeout: job.timeout || 240000, png: true };
  if (mode === 'image-to-image') {
    const inp = job.inputs[0];
    const r = await fetch(base + inp.url);
    if (!r.ok) { await post({ name: job.name, state: 'failed', detail: 'runner could not serve input ' + inp.file }); return 'failed'; }
    const blob = await r.blob();
    const ext = /png/.test(blob.type) ? '.png' : /webp/.test(blob.type) ? '.webp' : '.jpg';
    run.name = job.name + '_src_' + Date.now().toString(36) + ext;
    run.mime = blob.type || 'image/jpeg';
    run.b64 = await blobB64(blob);
    if (job.inputs.length > 1) jmSay(`${job.name}: only the first input is attached (${job.inputs.length} given)`);
  }
  let res;
  try { res = await chrome.tabs.sendMessage(tab.id, { cmd: 'run', job: run }); } catch (e) { res = { ok: false, error: String(e.message || e) }; }
  if (!res || !res.ok) {
    const err = res ? res.error : 'no answer from the Flow tab';
    b = await pageBlock(tab.id);
    if (!b && /waiting for (prompt box|Start generation)|Could not type the prompt|Upload media button never appeared/.test(err)) {
      b = { kind: 'ui-changed', detail: err.slice(0, 300) };
    }
    if (b) return blocked(b);
    jmSay(`${job.name}: failed - ${err}`);
    await post({ name: job.name, state: 'failed', detail: err.slice(0, 1000) });
    return 'failed';
  }
  const files = res.images.map((im, i) => ({ k: i + 1, type: im.type, b64: im.b64 }));
  const ans = await post({ name: job.name, state: 'downloaded', files });
  jmSay(`${job.name}: sent ${files.length} image(s) as ${files.map((f) => `${job.name}_${f.k}.png`).join(', ')}; runner: ${ans.state || ans.error || 'ok'}`);
  return 'ok';
}

async function jmLoop() {
  const base = `http://127.0.0.1:${JM.port}`;
  // extension API calls keep the service worker alive while a generation takes minutes
  const keep = setInterval(() => { chrome.runtime.getPlatformInfo(() => {}); }, 20000);
  let misses = 0;
  try {
    while (!JM.stop) {
      let r;
      try { r = await (await fetch(base + '/next', { cache: 'no-store' })).json(); misses = 0; } catch (e) {
        if (++misses === 1) jmSay(`runner not reachable on ${base}; retrying every 15 s`);
        if (misses > 40) { jmSay('runner not reachable for 10 minutes; job mode off'); break; }
        jmState('waiting for runner'); await jmSleep(15000); continue;
      }
      if (r.done) { jmSay('runner finished: ' + r.run_state); break; }
      if (r.wait) { jmState(r.running ? 'waiting (runner busy)' : 'pause between jobs'); await jmSleep(Math.min(r.wait, 15000)); continue; }
      if (r.job && (await jmRunJob(base, r.job)) === 'blocked') break;
    }
  } finally {
    clearInterval(keep);
    JM.active = false;
    await chrome.storage.local.set({ bfJobActive: false });
    jmState(JM.stop ? 'stopped' : 'off');
  }
}
async function jmStart(port) {
  if (JM.active) return;
  JM.port = Math.max(1, Math.min(65535, parseInt(port, 10) || 8787));
  JM.active = true; JM.stop = false;
  await chrome.storage.local.set({ bfJobActive: true, bfJobPort: JM.port });
  jmSay(`on; polling http://127.0.0.1:${JM.port}`);
  jmState('starting');
  jmLoop();
}
chrome.runtime.onMessage.addListener((msg, _sender, send) => {
  if (!msg) return undefined;
  if (msg.cmd === 'job-start') { jmStart(msg.port).then(() => send({ ok: true })); return true; }
  if (msg.cmd === 'job-stop') { JM.stop = true; jmSay('stop requested; finishing the current job'); send({ ok: true }); return undefined; }
  if (msg.cmd === 'job-status') { send({ active: JM.active, state: JM.state, job: JM.job, port: JM.port }); return undefined; }
  return undefined;
});
// Resume after Chrome restarts the service worker, and start on browser start if the user chose that.
chrome.storage.local.get(['bfJobActive', 'bfJobPort']).then((s) => { if (s.bfJobActive) jmStart(s.bfJobPort); });
chrome.runtime.onStartup.addListener(() => {
  chrome.storage.local.get(['bfJobAuto', 'bfJobPort']).then((s) => { if (s.bfJobAuto) jmStart(s.bfJobPort); });
});
