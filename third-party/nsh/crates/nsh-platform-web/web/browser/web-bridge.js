// A web view's bridge (`webBridge` in `nsh.js`) as a file: the player's
// page loads it in the web view's HTML by URL (`<script src>`, its token in
// `data-nsh-token`), so a page served with a strict `script-src` ('self'),
// which the web view inherits, runs it.
(() => {
  const token = document.currentScript.dataset.nshToken;
  let port = null;
  const queue = [];
  window.nsh = { postMessage(data) { data = String(data); port ? port.postMessage(data) : queue.push(data); } };
  addEventListener("message", (e) => {
    if (port || e.source !== parent || e.data !== token || !e.ports[0]) return;
    e.stopImmediatePropagation();
    port = e.ports[0];
    port.onmessage = (m) => {
      const d = m.data;
      if (d && d.eval != null) { try { (0, eval)(String(d.eval)); } catch (err) { console.error(err); } }
      else if (d && d.go) history.go(d.go);
    };
    for (const data of queue.splice(0)) port.postMessage(data);
  });
})();
