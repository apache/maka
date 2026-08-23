#!/usr/bin/env electron
/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

/**
 * P5 — real Electron observe→act smoke for the embedded browser.
 *
 * Run as an Electron main entry (`electron scripts/browser-observe-act-smoke.mjs`,
 * or `npm --workspace @maka/desktop run smoke:browser`). It drives the
 * *production* automation path end to end against a live Chromium:
 *
 *   BrowserViewController.attachAutomation()  → CdpBridge (sealed ws server)
 *     → opencli CDPBridge.connect()           → real webContents.debugger
 *       → snapshot / fillText / click / evaluate / extract
 *
 * This is the one seam the unit tests fake out (they stub the bridge + IPage):
 * the real CDP round trip over a real DOM. A loopback HTTP server hosts a tiny
 * form fixture, so the run is deterministic and needs no network.
 *
 * It then drives the visible-lease end to end through BrowserSession + the real
 * host/manager/controller (the unit tests cover it only with a fake host): a
 * background conversation's navigate/mutate is rejected and creates no view,
 * while a shown conversation whose viewport has been reported can click/type.
 *
 * Exit 0 = every step passed; non-zero = a step failed or the run timed out.
 */

import { createServer } from 'node:http';
import { app, BrowserWindow, session } from 'electron';
import { CDPBridge } from '@jackwener/opencli/browser/cdp';
import { htmlToMarkdown } from '@jackwener/opencli/utils';
import { BrowserViewController } from '../dist/main/browser/controller.js';
import { BrowserViewManager } from '../dist/main/browser/view-manager.js';
import { createBrowserViewHost } from '../dist/main/browser/automation-host.js';
import { provideBrowserViewHost } from '../dist/main/browser/browser-host.js';
import {
  withBrowserPage,
  releaseBrowserSession,
  revokeHiddenBrowserActions,
  BrowserActionBlockedError,
  BrowserActionRevokedError,
} from '../dist/main/browser/session.js';

const FIXTURE = `<!doctype html>
<html>
  <head><meta charset="utf-8"><title>Maka Smoke</title></head>
  <body>
    <h1>Maka observe-to-act smoke</h1>
    <input id="q" type="text" aria-label="search query">
    <button id="go" type="button">Go</button>
    <div id="out"></div>
    <script>
      document.getElementById('go').addEventListener('click', () => {
        document.getElementById('out').textContent = 'clicked:' + document.getElementById('q').value;
      });
    </script>
  </body>
</html>`;

const RUN_TIMEOUT_MS = 60_000;
const log = (m) => console.log(`[browser-smoke] ${m}`);

/** First `[N]` ref on the snapshot line that mentions `needle`, or null. */
function findRef(snapshot, needle) {
  for (const line of String(snapshot).split('\n')) {
    if (!line.toLowerCase().includes(needle.toLowerCase())) continue;
    const m = /\[(\d+)\]/.exec(line);
    if (m) return m[1];
  }
  return null;
}

async function waitForPageValue(read, expected, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  let actual;
  do {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;
    actual = await read(remainingMs);
    if (actual === expected) return actual;
    const pollDelayMs = Math.min(20, deadline - Date.now());
    if (pollDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, pollDelayMs));
    }
  } while (Date.now() < deadline);
  return actual;
}

async function runSmoke() {
  // Loopback fixture server, OS-assigned port — deterministic, no network.
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(FIXTURE);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const fixtureUrl = `http://127.0.0.1:${server.address().port}/`;
  log(`fixture served at ${fixtureUrl}`);

  // The view must actually paint: opencli's native CDP click hit-tests a
  // composited frame. A hidden window with a zero-bounds view never composites,
  // so show the window (without stealing focus) and give the view real on-screen
  // bounds, mirroring a displayed page.
  const win = new BrowserWindow({ show: false, width: 1024, height: 768 });
  win.showInactive();
  const controller = new BrowserViewController(win, 'smoke', () => {});
  controller.setViewport({ x: 0, y: 0, width: 1024, height: 768 });
  const bridge = new CDPBridge();
  // The visible-lease section (below) wires a real host over this manager;
  // declared here so finally can tear it down.
  let leaseManager = null;

  const checks = [];
  const check = (name, ok, detail = '') => {
    checks.push({ name, ok });
    log(`${ok ? 'PASS' : 'FAIL'} — ${name}${detail ? ` (${detail})` : ''}`);
  };

  try {
    // The page-security backstop is installed once per shared partition session,
    // not once per view: a second view must NOT add a second will-download listener.
    const partition = session.fromPartition('persist:maka-browser');
    const downloadListenersBefore = partition.listenerCount('will-download');
    const controller2 = new BrowserViewController(win, 'smoke-backstop', () => {});
    check(
      'security backstop installs once per partition (no listener pileup)',
      downloadListenersBefore === 1 &&
        partition.listenerCount('will-download') === downloadListenersBefore,
      `${downloadListenersBefore} -> ${partition.listenerCount('will-download')}`,
    );
    await controller2.dispose();

    // Production attach: WebContents debugger → sealed loopback ws endpoint.
    const endpoint = await controller.attachAutomation();
    check('attachAutomation returns a loopback endpoint', /^ws:\/\/127\.0\.0\.1:\d+\//.test(endpoint.cdpEndpoint));

    // Show the view before driving — the precondition the visible lease enforces
    // in production, and what un-throttles the view so the native click below
    // hit-tests a composited frame (throttling now tracks shown-ness, not attach).
    controller.setViewport({ x: 0, y: 0, width: 1024, height: 768 });

    // opencli connects as the CDP client (stealth auto-registers on connect).
    const page = await bridge.connect({ cdpEndpoint: endpoint.cdpEndpoint });
    check('opencli CDPBridge.connect resolves a page', typeof page?.snapshot === 'function');

    // Navigate via the agent path (opencli goto, same call browser_navigate makes).
    await page.goto(fixtureUrl, { waitUntil: 'load' });
    const landed = (await page.getCurrentUrl?.()) ?? '';
    check('goto lands on the fixture URL', landed.startsWith(fixtureUrl), landed);

    // OBSERVE: snapshot the interactive elements and read their numbered refs.
    const snapshot = await page.snapshot({ interactive: true });
    const queryRef = findRef(snapshot, 'search query');
    const submitRef = findRef(snapshot, 'Go');
    check('snapshot lists the query field with a [ref]', Boolean(queryRef), `ref=${queryRef}`);
    check('snapshot lists the Go button with a [ref]', Boolean(submitRef), `ref=${submitRef}`);
    if (!queryRef || !submitRef) {
      log(`--- snapshot dump ---\n${snapshot}\n--- end snapshot ---`);
      throw new Error('snapshot did not expose the expected numbered refs');
    }

    // ── Visible-lease, end to end through BrowserSession + the real host ──────
    // Exercises the wiring the fake-host unit tests can't: controller
    // .hasLiveViewport() ← setViewport, the host's canDrive, and the gate firing
    // before resolveEndpoint. Free the direct-driven view first so this section
    // owns the window (the native click needs the one composited frame).
    await bridge.close().catch(() => {});
    await controller.dispose().catch(() => {});
    leaseManager = new BrowserViewManager({ create: (id) => new BrowserViewController(win, id, () => {}) });
    let shownSession = null;
    provideBrowserViewHost(createBrowserViewHost(leaseManager, () => shownSession));

    // Background conversation (not the one on screen): EVERY kind — read,
    // navigate, mutate — is rejected, and the gate runs before acquire, so no
    // view or connection is created. observe is the P2-A case (a backgrounded
    // conversation must not snapshot/extract a logged-in page the user can't
    // see); mutate is the click-on-a-hidden-view case. Both get real-host
    // coverage here, not just the fake-host unit tests.
    shownSession = 'other-conversation';
    let bgNavBlocked = false;
    try {
      await withBrowserPage('leaseS', 'navigate', async () => {}, { takeover: 'navigate' });
    } catch (err) {
      bgNavBlocked = err instanceof BrowserActionBlockedError;
    }
    check('visible-lease rejects a background-conversation navigate', bgNavBlocked);
    let bgMutateBlocked = false;
    try {
      await withBrowserPage('leaseS', 'click', async () => {}, { takeover: 'mutate' });
    } catch (err) {
      bgMutateBlocked = err instanceof BrowserActionBlockedError;
    }
    check('visible-lease rejects a background-conversation mutate', bgMutateBlocked);
    let bgObserveBlocked = false;
    try {
      await withBrowserPage('leaseS', 'snapshot', async () => {}, { takeover: 'observe' });
    } catch (err) {
      bgObserveBlocked = err instanceof BrowserActionBlockedError;
    }
    check('visible-lease rejects a background-conversation observe (no off-screen reads)', bgObserveBlocked);
    check('a lease-rejected action creates no view or connection', leaseManager.liveCount() === 0);

    // Shown conversation: navigate is allowed (it creates the panel) and loads.
    shownSession = 'leaseS';
    await withBrowserPage('leaseS', 'navigate', async (lease) => lease.goto(fixtureUrl, { waitUntil: 'load' }), {
      takeover: 'navigate',
    });

    // Renderer reports the on-screen viewport → observe to read the numbered refs.
    leaseManager.get('leaseS').setViewport({ x: 0, y: 0, width: 1024, height: 768 });
    const leaseSnap = await withBrowserPage('leaseS', 'snapshot', (lease) => lease.snapshot({ interactive: true }), {
      takeover: 'observe',
    });
    const leaseQuery = findRef(leaseSnap, 'search query');
    const leaseSubmit = findRef(leaseSnap, 'Go');

    // Permission-modal race (the P1 fix): the modal hides the native view
    // (viewport cleared) while open, and the renderer restores the strip a moment
    // AFTER the user approves. A mutate firing in that gap must WAIT for the
    // restore and land, not reject. Clear the viewport, start a mutate, then
    // restore the viewport mid-flight — the type must still complete.
    leaseManager.get('leaseS').setViewport(null);
    const racingType = withBrowserPage('leaseS', 'type', (lease) => lease.fillText(leaseQuery, 'leased'), {
      takeover: 'mutate',
    });
    setTimeout(() => leaseManager.get('leaseS').setViewport({ x: 0, y: 0, width: 1024, height: 768 }), 30);
    let raceLanded = false;
    try {
      const result = await racingType;
      raceLanded = result.verified === true && result.actual === 'leased';
    } catch {
      raceLanded = false;
    }
    check('visible-lease waits out a modal-close viewport restore and verifies the typed value', raceLanded);

    // With the viewport back, a click drives the real DOM.
    const leaseClick = await withBrowserPage('leaseS', 'click', (lease) => lease.click(leaseSubmit), {
      takeover: 'mutate',
    });
    check(
      'visible-lease click resolves a single match by ref',
      leaseClick.matches_n === 1,
      `matches_n=${leaseClick.matches_n}`,
    );
    const leaseOut = await waitForPageValue(
      (remainingMs) =>
        withBrowserPage(
          'leaseS',
          'read',
          (lease) => lease.evaluate('document.getElementById("out").textContent'),
          { takeover: 'observe', timeoutMs: remainingMs },
        ),
      'clicked:leased',
    );
    check('visible-lease allows + lands a click once shown with a viewport', leaseOut === 'clicked:leased');

    // EXTRACT through the same production session path.
    const leaseHtml = await withBrowserPage(
      'leaseS',
      'extract',
      (lease) => lease.evaluate('document.body.outerHTML'),
      { takeover: 'observe' },
    );
    const markdown = htmlToMarkdown(String(leaseHtml));
    check('extract markdown reflects the page effect', markdown.includes('clicked:leased'));

    // Throttling tracks shown-ness (the P2 fix): a shown view runs full-speed so
    // native clicks composite, and HIDING it restores background throttling so a
    // backgrounded conversation's cached page can't drain CPU.
    const leaseView = leaseManager.get('leaseS');
    check('a shown view runs un-throttled', leaseView.isBackgroundThrottled() === false);
    leaseView.setViewport(null); // user switches away / panel hides
    check('hiding a view restores background throttling (no hidden-page CPU drain)', leaseView.isBackgroundThrottled() === true);
    leaseView.setViewport({ x: 0, y: 0, width: 1024, height: 768 }); // re-show for the revoke check

    // Continuous lease (the P1 revoke fix): an action that started while the
    // conversation was on screen must be SEVERED if the user switches away mid-
    // run — not left reading the now-hidden page. Start a long read on the live
    // cached connection, flip the shown conversation, and revoke; it must reject
    // with the revoked error against the REAL bridge (the fake-host unit tests
    // can't prove the live sever).
    let revoked = false;
    const longRead = withBrowserPage('leaseS', 'read', () => new Promise(() => {}), { takeover: 'observe' });
    longRead.catch(() => {}); // asserted below; pre-handle so the reject is never unhandled
    await new Promise((resolve) => setTimeout(resolve, 20)); // reuse the cached conn + enter run()
    shownSession = 'other-conversation';
    revokeHiddenBrowserActions('other-conversation');
    try {
      await longRead;
    } catch (err) {
      revoked = err instanceof BrowserActionRevokedError;
    }
    check('continuous lease revokes an in-flight read when the conversation goes off screen', revoked);
  } finally {
    // Teardown mirrors detach: close the client, stop the bridge, drop the view.
    try {
      await bridge.close();
    } catch {
      /* already closed */
    }
    try {
      await controller.dispose();
    } catch {
      /* view already gone */
    }
    try {
      await releaseBrowserSession('leaseS');
      await leaseManager?.disposeAll();
      provideBrowserViewHost(null);
    } catch {
      /* lease teardown is best-effort */
    }
    try {
      if (!win.isDestroyed()) win.destroy();
    } catch {
      /* window already gone */
    }
    await new Promise((resolve) => server.close(resolve));
  }

  const passed = checks.filter((c) => c.ok).length;
  log(`${passed}/${checks.length} checks passed`);
  return passed === checks.length && checks.length > 0;
}

async function main() {
  await app.whenReady();
  let code = 1;
  try {
    const ok = await Promise.race([
      runSmoke(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`smoke timed out after ${RUN_TIMEOUT_MS}ms`)), RUN_TIMEOUT_MS),
      ),
    ]);
    code = ok ? 0 : 1;
    log(ok ? 'RESULT: PASS' : 'RESULT: FAIL');
  } catch (err) {
    log(`RESULT: FAIL — ${err instanceof Error ? err.message : String(err)}`);
  }
  app.exit(code);
}

main();
