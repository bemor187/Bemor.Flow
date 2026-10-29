// Bemor.Flow content script. Drives the Flow project page: upload the source image, attach it as an
// ingredient, type the prompt, generate, and hand back the new images. Selectors are accessible labels,
// which are the most stable thing on the page.
(() => {
  if (window.__gwFlow) return;
  window.__gwFlow = true;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function waitFor(what, fn, timeout = 30000, step = 200) {
    const t = Date.now();
    for (;;) {
      const v = fn();
      if (v) return v;
      if (Date.now() - t > timeout) throw new Error('Timed out waiting for ' + what);
      await sleep(step);
    }
  }
  const btn = (label) =>
    [...document.querySelectorAll('button')].find((b) => (b.getAttribute('aria-label') || '') === label);
  const btnHas = (label) =>
    [...document.querySelectorAll('button')].find((b) =>
      (b.getAttribute('aria-label') || '').toLowerCase().includes(label.toLowerCase()));
  const byText = (txt) => [...document.querySelectorAll('button')].find((b) => (b.innerText || '').includes(txt));
  const exactText = (txt) => [...document.querySelectorAll('button')].find((b) => (b.innerText || '').trim() === txt);
  // Picker row for an uploaded file. Flow may show the name with or without its extension, or cut it short.
  const rowFor = (name) => {
    const stem = name.replace(/\.[^.]+$/, '');
    return [...document.querySelectorAll('button')].find((b) => {
      const t = b.innerText || '';
      if (!/\bImage\b/.test(t)) return false;
      const first = t.split('\n')[0].trim().replace(/…$/, '').replace(/\.\.\.$/, '');
      return first === name || first === stem || (first.length >= 12 && stem.startsWith(first));
    });
  };
  const uploadBtn = () => btn('Upload media') || byText('Upload media');
  // narrow windows show a full-screen picker, wide ones a popover; both have the same pieces
  function closePicker() {
    const c = btn('Close');
    if (c) c.click();
    else { const t = btn('Add ingredients to the prompt box'); if (t && uploadBtn()) t.click(); }
  }
  const promptBox = () => document.querySelector('[role=textbox][aria-label="What do you want to create?"]');
  const tiles = () => [...document.querySelectorAll('img[alt^="Tile displaying"]')];

  function toB64(blob) {
    return new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(String(r.result).split(',')[1]);
      r.onerror = rej;
      r.readAsDataURL(blob);
    });
  }

  function onceMessage(type, timeout) {
    return new Promise((res, rej) => {
      const t = setTimeout(() => { window.removeEventListener('message', h); rej(new Error('Timed out: ' + type)); }, timeout);
      function h(e) {
        if (e.source === window && e.data && e.data.type === type) {
          clearTimeout(t); window.removeEventListener('message', h); res(e.data);
        }
      }
      window.addEventListener('message', h);
    });
  }

  async function trustedClick(el) {
    const r = el.getBoundingClientRect();
    const res = await chrome.runtime.sendMessage({ cmd: 'trusted-click', x: r.left + r.width / 2, y: r.top + r.height / 2 });
    if (!res || !res.ok) throw new Error('Trusted click failed: ' + (res && res.error));
  }

  async function setPrompt(text) {
    const box = promptBox();
    box.focus();
    document.execCommand('selectAll', false);
    document.execCommand('insertText', false, text);
    await sleep(300);
    if (!box.innerText.trim().startsWith(text.slice(0, 20))) {
      throw new Error('Could not type the prompt into Flow');
    }
  }

  const step = (t) => { try { chrome.runtime.sendMessage({ cmd: 'progress', text: t }); } catch (e) { /* runner closed */ } };

  async function run(job) {
    await waitFor('prompt box', promptBox, 30000);
    step('page ready');
    // 1. upload the reference image
    const pend = onceMessage('gw-pending-ok', 5000);
    window.postMessage({ type: 'gw-pending', name: job.name, mime: job.mime, b64: job.b64 }, '*');
    await pend;
    step('file handed to the page');
    await chrome.runtime.sendMessage({ cmd: 'focus-tab' });   // a background tab renders slowly
    await sleep(2500);                                         // let Flow finish wiring its buttons
    const openPicker = async () => {
      let up = uploadBtn();
      for (let tries = 0; tries < 6 && !up; tries++) {
        const add = btn('Add ingredients to the prompt box');
        if (!add) { await sleep(1000); continue; }
        add.click();
        for (let i = 0; i < 12 && !up; i++) { await sleep(250); up = uploadBtn(); }
        if (!up) { closePicker(); await sleep(800); }
      }
      if (!up) {
        const labels = [...document.querySelectorAll('button')].map((b) => b.getAttribute('aria-label') || (b.innerText || '').split('\n')[0]).filter(Boolean).join(' | ');
        throw new Error('Upload media button never appeared. Buttons on the page: ' + labels.slice(-300));
      }
      return up;
    };
    const up = await openPicker();
    step('picker opened');
    const uploaded = onceMessage('gw-uploaded', 10000);
    up.click();
    await uploaded;
    step('uploaded; waiting for it in the picker');
    await waitFor('uploaded asset ' + job.name, () => rowFor(job.name), 60000);
    // Attach it. Narrow layout: one click on the row. Wide layout: click the row, then "Add to prompt".
    // A freshly uploaded row can ignore clicks, so if nothing attaches, close and reopen the picker and retry.
    for (let tries = 0; tries < 4 && !btn('Ingredient'); tries++) {
      await sleep(1500);
      let r = rowFor(job.name);
      if (!r) { await openPicker(); r = await waitFor('uploaded asset ' + job.name, () => rowFor(job.name), 15000); }
      await sleep(600);
      r.scrollIntoView({ block: 'center' });
      await sleep(300);
      // first try a normal click; if Flow ignored it, send a real (trusted) click like Generate needs
      if (tries === 0) r.click(); else await trustedClick(r);
      step('clicked uploaded row (try ' + (tries + 1) + ')');
      await sleep(1200);
      const addTo = exactText('Add to prompt');
      if (addTo) { if (tries === 0) addTo.click(); else await trustedClick(addTo); }
      await sleep(2000);
      if (!btn('Ingredient')) { closePicker(); await sleep(1200); }
    }
    await waitFor('ingredient chip', () => btn('Ingredient'), 10000);
    step('attached as ingredient');
    if (uploadBtn()) { closePicker(); await sleep(800); }
    await setPrompt(job.prompt);
    step('prompt typed');
    // 4. generate and wait for new tiles
    const before = new Set(tiles().map((i) => i.src));
    const go = await waitFor('Start generation', () => { const b = btn('Start generation'); return b && !b.disabled ? b : null; }, 10000);
    await trustedClick(go);
    step('generate clicked; waiting for images');
    const want = job.count || 2;
    const t0 = Date.now();
    let fresh = [];
    for (;;) {
      fresh = tiles().filter((i) => !before.has(i.src) && i.naturalWidth > 200);
      if (fresh.length >= want) break;
      if (Date.now() - t0 > job.timeout) {
        if (fresh.length) break;
        throw new Error('Generation timed out (no image appeared)');
      }
      await sleep(1000);
    }
    await sleep(1500);
    fresh = tiles().filter((i) => !before.has(i.src) && i.naturalWidth > 200);
    const out = [];
    for (const img of fresh.slice(0, want)) {
      const blob = await (await fetch(img.src)).blob();
      out.push({ type: blob.type || 'image/jpeg', b64: await toB64(blob) });
    }
    return out;
  }

  chrome.runtime.onMessage.addListener((msg, _sender, send) => {
    if (msg.cmd === 'ping') {
      send({ ready: !!promptBox(), url: location.href });
      return;
    }
    if (msg.cmd === 'run') {
      run(msg.job).then((images) => send({ ok: true, images }), (e) => send({ ok: false, error: String(e.message || e) }));
      return true; // async
    }
  });
})();
