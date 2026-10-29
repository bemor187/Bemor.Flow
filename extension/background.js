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
