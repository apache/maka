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
 * #5235: the Electron boundary is the real WebContents load/error lifecycle,
 * the sealed CDP bridge, sandboxed ArtifactPreview scripts and native click.
 * Fake IPage tests cannot establish that Chromium ran the fixture JavaScript.
 * Artifact storage reads are fixtures; preview serving and all browser tools
 * below are production implementations. This is not a model/Dev E2E claim.
 */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { app, BrowserWindow } from 'electron';
import { ManagedArtifactPreview } from '../dist/main/managed-artifact-preview.js';
import { buildManagedArtifactPreviewTools } from '../dist/main/managed-artifact-preview-tools.js';
import {
  buildBrowserNavigateTool,
  buildBrowserSnapshotTool,
  buildBrowserClickTool,
} from '../dist/main/browser/browser-tools.js';
import { BrowserViewController } from '../dist/main/browser/controller.js';
import { BrowserViewManager } from '../dist/main/browser/view-manager.js';
import { createBrowserViewHost } from '../dist/main/browser/automation-host.js';
import { provideBrowserViewHost } from '../dist/main/browser/browser-host.js';
import { withBrowserOriginAdmission } from '../dist/main/browser/browser-origin-admission.js';
import { releaseBrowserSession } from '../dist/main/browser/session.js';
import { runPreviewPreflight } from '../dist/main/preview-preflight.js';
import { createPreviewPreflightAuthority } from '../dist/main/preview-preflight-probes.js';
import { redactPreviewCapabilities } from '../dist/main/browser/browser-verification.js';

// Electron's default loadURL warning contains the bearer path. Preserve the
// warning in this isolated test process, but never print the capability.
process.removeAllListeners('warning');
process.on('warning', (warning) => console.error(redactPreviewCapabilities(warning.message)));

const html = `<!doctype html><html><head><meta charset="utf-8"><title>Preview 5235</title></head>
<body><h1>PREVIEW_READY_5235</h1><button id="counter" onclick="this.textContent=String(Number(this.textContent)+1)">0</button></body></html>`;
const bytes = Buffer.from(html);
const client = {
  getArtifact: async () => ({
    id: 'a1',
    sessionId: 's1',
    turnId: 't1',
    createdAt: 0,
    name: 'preview-5235.html',
    kind: 'html',
    sizeBytes: bytes.length,
    source: 'tool_result',
  }),
  streamArtifact: async (_session, _artifact, write) => {
    await write(bytes);
    return bytes.length;
  },
};
const userData = mkdtempSync(join(tmpdir(), 'maka-preview-5235-'));
app.setPath('userData', userData);
app.on('window-all-closed', () => {});
const watchdog = setTimeout(() => {
  console.error('FAIL preview smoke deadline');
  app.exit(1);
}, 150_000);
const log = (name) => console.log(`PASS ${name}`);
let sequence = 0;
function context(sessionId = 's1') {
  return {
    sessionId,
    turnId: 't1',
    toolCallId: `c${++sequence}`,
    cwd: userData,
    abortSignal: new AbortController().signal,
    emitOutput() {},
  };
}
function browserCall(tool, args, approvedUrl, sessionId = 's1') {
  return withBrowserOriginAdmission({ sessionId, url: approvedUrl }, () =>
    tool.impl(args, context(sessionId)),
  );
}
function assertNotOpened(result, status = 'failed') {
  assert.equal(result.status, status);
  assert.equal(result.opened, false);
  assert.equal(result.loaded, false);
  assert.equal(result.url, null);
  assert.equal(result.title, null);
  assert.equal(result.documentId, undefined);
}

async function main() {
  let code = 1;
  await app.whenReady();
  console.log('Running managed preview / Chromium regression checks');
  const win = new BrowserWindow({ show: false, width: 900, height: 650 });
  win.showInactive();
  const manager = new BrowserViewManager({
    create: (id) => new BrowserViewController(win.contentView, id, () => {}),
  });
  provideBrowserViewHost(createBrowserViewHost(manager, () => true));
  const previews = new ManagedArtifactPreview();
  const expiring = new ManagedArtifactPreview(100);
  const sockets = new Set();
  const slowServer = createServer((req, res) => {
    if (req.url === '/partial' || req.url === '/stop') {
      res.writeHead(200, { 'content-type': 'text/html', 'content-length': '100000' });
      res.write('<!doctype html><title>Partial document</title><button>Still usable</button>');
      const timer = setTimeout(() => {
        if (req.url === '/partial') res.end();
        else manager.get('s1').stop();
      }, 250);
      res.on('close', () => clearTimeout(timer));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.write('<!doctype html><title>Still loading</title><p>Unfinished body');
  });
  slowServer.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  try {
    const [artifactPreview] = buildManagedArtifactPreviewTools((sessionId, artifactId, signal) =>
      previews.prepare('smoke', client, sessionId, artifactId, signal),
    );
    const endpoint = await artifactPreview.impl({ artifactId: 'a1' }, context());
    assert.equal(endpoint.reachable, true);
    assert.equal(endpoint.loaded, false);
    const navigate = buildBrowserNavigateTool();
    const snapshot = buildBrowserSnapshotTool();
    const click = buildBrowserClickTool();
    const navigation = await browserCall(navigate, { url: endpoint.url }, endpoint.url);
    assert.equal(navigation.status, 'completed', JSON.stringify(navigation));
    assert.equal(navigation.loaded, true);
    assert.equal(navigation.title, 'Preview 5235');
    assert.equal(navigation.matchesRequestedUrl, true);
    manager.get('s1').setViewport({ x: 0, y: 0, width: 900, height: 650 });
    const before = await browserCall(snapshot, {}, endpoint.url);
    assert.equal(before.status, 'completed', JSON.stringify(before));
    assert.equal(before.title, 'Preview 5235');
    assert.match(before.snapshot, /PREVIEW_READY_5235/);
    assert.match(before.snapshot, /<button\b[^>]*>0<\/button>/);
    const ref = before.snapshot
      .split('\n')
      .find((line) => /<button\b[^>]*>0<\/button>/.test(line))
      ?.match(/\[(\d+)\]/)?.[1];
    assert.ok(ref, 'snapshot must expose a real counter ref');
    const action = await browserCall(click, { ref }, endpoint.url);
    assert.equal(action.status, 'completed', JSON.stringify(action));
    assert.equal(action.click.interaction, 'not_verified');
    const after = await browserCall(snapshot, {}, endpoint.url);
    assert.equal(after.status, 'completed', JSON.stringify(after));
    assert.equal(after.documentId, before.documentId);
    assert.equal(before.documentId, navigation.documentId);
    assert.match(after.snapshot, /PREVIEW_READY_5235/);
    assert.match(after.snapshot, /<button\b[^>]*>1<\/button>/);
    assert.doesNotMatch(
      JSON.stringify([navigation, before, action, after]),
      new RegExp(new URL(endpoint.url).pathname),
    );
    log(
      'ArtifactPreview → navigate → snapshot → click → snapshot; title, marker, real JavaScript 0 → 1',
    );

    const preflight = await runPreviewPreflight(createPreviewPreflightAuthority(), {
      sessionId: 's1',
      origin: new URL(endpoint.url).origin,
      abortSignal: new AbortController().signal,
    });
    assert.equal(preflight.endpoint, 'verified'); // HEAD / returns 404, still only a listener.
    assert.equal(preflight.capabilities.find((c) => c.id === 'url_schemes').status, 'unsupported');
    const missing = new URL('missing', endpoint.url).href;
    assertNotOpened(await browserCall(navigate, { url: missing }, missing));
    log('listener verified and file unsupported do not turn an HTTP 404 into preview success');

    await previews.releaseUrl(endpoint.url);
    assertNotOpened(await browserCall(navigate, { url: endpoint.url }, endpoint.url));
    log('revoked preview fails without opened/loaded or old document evidence');

    const expired = await expiring.prepare('expiry', client, 's1', 'a1');
    await new Promise((resolve) => setTimeout(resolve, 150));
    assertNotOpened(await browserCall(navigate, { url: expired.url }, expired.url));
    log('expired preview fails without opened/loaded');

    // Reserve and release an OS-selected port, then immediately navigate to it.
    const reservation = createServer();
    await new Promise((resolve) => reservation.listen(0, '127.0.0.1', resolve));
    const unreachable = `http://127.0.0.1:${reservation.address().port}/unreachable`;
    await new Promise((resolve) => reservation.close(resolve));
    assertNotOpened(await browserCall(navigate, { url: unreachable }, unreachable));
    log('unreachable endpoint fails');

    await new Promise((resolve) => slowServer.listen(0, '127.0.0.1', resolve));
    const failureResults = [];
    for (const [path, expectedStatus] of [
      ['partial', 'failed'],
      ['stop', 'invalidated'],
    ]) {
      const url = `http://127.0.0.1:${slowServer.address().port}/${path}`;
      const view = manager.get('s1');
      const errors = [];
      const wc = win.contentView.children[0].webContents;
      const recordFailure = (_event, code, _description, failedUrl, mainFrame) => {
        if (mainFrame && failedUrl === url) errors.push(code);
      };
      wc.on('did-fail-load', recordFailure);
      let result;
      try {
        result = await browserCall(navigate, { url }, url);
      } finally {
        wc.off('did-fail-load', recordFailure);
      }
      assert.ok(
        errors.includes(path === 'partial' ? -354 : -3),
        'real main-frame load failure must occur',
      );
      // A readable, committed DOM must not substitute for a completed load.
      assert.equal(view.state().loadError, null, 'keep the existing partial-page UI usable');
      failureResults.push({ path, expectedStatus, result });
    }
    const incorrect = failureResults.filter(
      ({ expectedStatus, result }) =>
        result.status !== expectedStatus || result.loaded || result.opened,
    );
    assert.deepEqual(
      incorrect.map(({ path, result }) => ({ path, status: result.status, loaded: result.loaded })),
      [],
    );
    for (const { path, expectedStatus, result } of failureResults) {
      assertNotOpened(result, expectedStatus);
      log(`${path}: committed interrupted document never reports loaded`);
    }
    const slowUrl = `http://127.0.0.1:${slowServer.address().port}/slow`;
    const started = Date.now();
    assertNotOpened(await browserCall(navigate, { url: slowUrl }, slowUrl), 'timeout');
    assert.ok(
      Date.now() - started < 40_000,
      'existing navigation deadline must bound an unfinished document',
    );
    log('never-completing real page returns bounded timeout');

    await releaseBrowserSession('s1');
    const unobserved = await browserCall(snapshot, {}, new URL(slowUrl).origin);
    assert.notEqual(unobserved.status, 'completed');
    assert.equal(unobserved.documentId, undefined);
    const replacement = await previews.prepare('smoke', client, 's1', 'a1');
    const restored = await browserCall(navigate, { url: replacement.url }, replacement.url);
    assert.equal(restored.status, 'completed', JSON.stringify(restored));
    assert.notEqual(restored.documentId, before.documentId);
    log('closed/recreated page cannot reuse prior evidence');
    code = 0;
  } catch (error) {
    // Tool results are already sanitized. Avoid dumping raw CDP URLs or stacks.
    console.error(
      `FAIL preview verification: ${String(error.message).replace(/\/[a-f0-9]{64}\/index\.html/gi, '/[preview-token]/index.html')}`,
    );
  } finally {
    clearTimeout(watchdog);
    await previews.close();
    await expiring.close();
    for (const socket of sockets) socket.destroy();
    if (slowServer.listening) await new Promise((resolve) => slowServer.close(resolve));
    await releaseBrowserSession('s1');
    await manager.disposeAll();
    provideBrowserViewHost(null);
    win.destroy();
    await rm(userData, { recursive: true, force: true, maxRetries: 3 });
    app.exit(code);
  }
}
// Do not await app readiness at ESM top level: Electron must finish loading the entry first.
main().catch(() => {
  console.error('FAIL preview smoke setup');
  app.exit(1);
});
