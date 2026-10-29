// Runs inside the Flow page (MAIN world). Flow's upload button creates an <input type=file> and
// calls click(); while a file is pending we hand it over instead of opening the native dialog.
(() => {
  if (window.__gwInstalled) return;
  window.__gwInstalled = true;
  window.__gwPending = null;
  window.addEventListener('message', (e) => {
    const d = e.data;
    if (e.source !== window || !d || d.type !== 'gw-pending') return;
    const bin = atob(d.b64);
    const u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    window.__gwPending = new File([u], d.name, { type: d.mime || 'image/jpeg' });
    window.postMessage({ type: 'gw-pending-ok' }, '*');
  });
  const origClick = HTMLInputElement.prototype.click;
  HTMLInputElement.prototype.click = function () {
    if (this.type === 'file' && window.__gwPending) {
      const f = window.__gwPending;
      window.__gwPending = null;
      const dt = new DataTransfer();
      dt.items.add(f);
      this.files = dt.files;
      this.dispatchEvent(new Event('input', { bubbles: true }));
      this.dispatchEvent(new Event('change', { bubbles: true }));
      window.postMessage({ type: 'gw-uploaded', name: f.name }, '*');
      return;
    }
    return origClick.call(this);
  };
})();
