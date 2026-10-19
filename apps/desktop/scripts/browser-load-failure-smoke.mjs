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

// Real Electron boundary: Chromium's load/failure/redirect event ordering and
// WebContentsView visibility cannot be established by renderer component tests.
// Run after building: electron scripts/browser-load-failure-smoke.mjs
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { rm } from 'node:fs/promises';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { app, BrowserWindow } from 'electron';
import { BrowserViewController } from '../dist/main/browser/controller.js';

const userData = mkdtempSync(join(tmpdir(), 'maka-browser-load-'));
app.setPath('userData', userData);
// Keep Electron alive after destroying the test window until cleanup has
// finished and app.exit() can report the assertion result explicitly.
app.on('window-all-closed', () => {});
const timeout = setTimeout(() => { console.error('Browser load smoke timed out'); app.exit(1); }, 30_000);
app.whenReady().then(async () => {
  let fail = true;
  let pending;
  let partial;
  let failureResponse = 'fail';
  const submissions = [];
  const sockets = new Set();
  const server = createServer((req, res) => {
    if (req.url === '/partial') {
      partial = res;
      res.writeHead(200, { 'content-type': 'text/html', 'content-length': '100000' });
      res.write('<!doctype html><title>Partial</title><button id="usable">Still usable</button>');
      return;
    }
    if (req.url === '/submit') {
      submissions.push({ method: req.method, referrer: req.headers.referer });
      if (req.method === 'POST') { res.destroy(); return; }
    }
    if (req.url === '/fail' && failureResponse === 'slow') { pending = res; return; }
    if (req.url === '/fail' && failureResponse === 'empty') { res.writeHead(204); res.end(); return; }
    if (req.url === '/fail' && failureResponse === 'download') {
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename=test.bin' });
      res.end('fixture');
      return;
    }
    if (req.url === '/slow') { pending = res; return; }
    if (req.url === '/redirect') { res.writeHead(302, { location: '/fail' }); res.end(); return; }
    if (req.url === '/frame' || (req.url === '/fail' && fail)) { res.destroy(); return; }
    res.end('<!doctype html><title>Recovered</title><iframe src="/frame"></iframe>');
  });
  server.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const win = new BrowserWindow({ show: false });
  win.showInactive();
  const states = [];
  const controller = new BrowserViewController(win.contentView, 'smoke', (_id, state) => states.push(state));
  const view = win.contentView.children[0];
  const rect = { x: 0, y: 0, width: 800, height: 500 };
  async function waitFor(predicate) {
    const deadline = Date.now() + 5000;
    while (!predicate()) {
      assert.ok(Date.now() < deadline, 'timed out waiting for browser state');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  let exitCode = 0;
  try {
    await controller.navigate(`${base}/fail`);
    await waitFor(() => !controller.state().loading);
    assert.equal(controller.state().loadError?.url, `${base}/fail`);
    controller.setViewport(rect);
    assert.equal(view.getVisible(), false, 'stale viewport must not cover failure UI');
    console.log('PASS initial failure and native view hidden');

    fail = false;
    controller.reload();
    await waitFor(() => controller.state().title === 'Recovered' && !controller.state().loading);
    assert.equal(controller.state().loadError, null);
    assert.equal(controller.state().url, `${base}/fail`);
    controller.setViewport(rect);
    assert.equal(view.getVisible(), true);
    console.log('PASS retry destination, recovery, and iframe failure ignored');

    fail = true;
    await controller.navigate(`${base}/redirect`);
    await waitFor(() => !controller.state().loading);
    assert.equal(controller.state().loadError?.url, `${base}/fail`);
    fail = false;
    controller.reload();
    await waitFor(() => !controller.state().loading && controller.state().loadError === null);
    assert.equal(controller.state().url, `${base}/fail`);
    console.log('PASS redirect failure retries final destination');

    states.length = 0;
    const stopped = controller.navigate(`${base}/slow`);
    await waitFor(() => !!pending);
    controller.stop();
    await stopped;
    await waitFor(() => !controller.state().loading);
    assert.equal(controller.state().loadError, null);
    pending = undefined;
    const superseded = controller.navigate(`${base}/slow`);
    await waitFor(() => !!pending);
    await controller.navigate(`${base}/ok`);
    await superseded;
    await waitFor(() => !controller.state().loading);
    assert.equal(controller.state().url, `${base}/ok`);
    assert.equal(states.some((state) => state.loadError), false);
    console.log('PASS stop and superseding navigation never publish errors');

    // A real committed response, then a truncated body: did-fail-load alone
    // cannot tell this usable document from a provisional navigation failure.
    states.length = 0;
    const partialFailure = new Promise((resolve) => view.webContents.once('did-fail-load', (_event, code) => resolve(code)));
    const partialLoad = controller.navigate(`${base}/partial`);
    await waitFor(() => controller.state().title === 'Partial');
    controller.setViewport(rect);
    partial.end();
    assert.equal(await partialFailure, -354);
    await partialLoad;
    await waitFor(() => !controller.state().loading);
    assert.equal(controller.state().loadError, null);
    assert.equal(states.some((state) => state.loadError), false);
    assert.equal(view.getVisible(), true);
    assert.equal(controller.hasLiveViewport(), true);
    assert.equal(await view.webContents.executeJavaScript('document.querySelector("#usable").textContent'), 'Still usable');
    console.log('PASS a committed partial page stays visible and usable after body failure');

    fail = true;
    await controller.navigate(`${base}/fail`);
    await waitFor(() => !controller.state().loading);
    const originalError = controller.state().loadError;
    assert.equal(originalError?.url, `${base}/fail`);
    states.length = 0;
    pending = undefined;
    failureResponse = 'slow';
    controller.reload();
    await waitFor(() => !!pending);
    assert.deepEqual(controller.state().loadError, originalError);
    controller.stop();
    await waitFor(() => !controller.state().loading);
    assert.deepEqual(controller.state().loadError, originalError);
    assert.equal(states.every((state) => !!state.loadError), true);
    for (const response of ['empty', 'download']) {
      failureResponse = response;
      await controller.navigate(`${base}/fail`);
      await waitFor(() => !controller.state().loading);
      assert.deepEqual(controller.state().loadError, originalError);
      controller.setViewport(rect);
      assert.equal(view.getVisible(), false);
    }
    failureResponse = 'fail';
    fail = false;
    await controller.navigate(`${base}/fail`);
    await waitFor(() => !controller.state().loading);
    assert.equal(controller.state().loadError, null);
    console.log('PASS cancelled retries, 204s, and downloads preserve the error until a document commits');

    await view.webContents.loadURL(`${base}/submit`, {
      postData: [{ type: 'rawData', bytes: Buffer.from('answer=fixture') }],
      extraHeaders: 'Content-Type: application/x-www-form-urlencoded',
      httpReferrer: `${base}/form`,
    }).catch(() => {});
    await waitFor(() => !controller.state().loading);
    assert.equal(controller.state().loadError?.url, `${base}/submit`);
    controller.reload();
    await waitFor(() => controller.state().url === `${base}/submit` && !controller.state().loading && !controller.state().loadError);
    assert.deepEqual(submissions, [
      { method: 'POST', referrer: `${base}/form` },
      { method: 'GET', referrer: undefined },
    ]);
    console.log('PASS retry uses GET without replaying POST data or the original referrer');
  } catch (error) {
    console.error(error);
    exitCode = 1;
  } finally {
    await controller.dispose();
    win.destroy();
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
    await rm(userData, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
    clearTimeout(timeout);
    app.exit(exitCode);
  }
}).catch((error) => { console.error(error); app.exit(1); });
