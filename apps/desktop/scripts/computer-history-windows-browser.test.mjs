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

import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, openSync, writeFileSync, writeSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { createInterface } from 'node:readline';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const helper = process.env.MAKA_HISTORY_WINDOWS_HELPER
  ?? fileURLToPath(new URL('../resources/bin/open-history.exe', import.meta.url));
const edge = process.env.MAKA_HISTORY_WINDOWS_EDGE
  ?? String.raw`C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`;
const fixture = fileURLToPath(new URL('./computer-history-windows-browser.fixture.ps1', import.meta.url));
const optedIn = process.env.MAKA_HISTORY_WINDOWS_BROWSER_TEST === '1';
const physicalMode = process.env.MAKA_HISTORY_WINDOWS_BROWSER_INPUT_TEST === '1';
const inputRequestPath = process.env.MAKA_HISTORY_WINDOWS_INPUT_REQUEST;

async function pollUntil(check, label, timeout = 10_000) {
  const deadline = performance.now() + timeout;
  while (performance.now() < deadline) {
    const value = await check();
    if (value) return value;
    await delay(100);
  }
  assert.fail(`Timed out waiting for ${label}`);
}

async function cleanupAll(steps) {
  const errors = [];
  for (const step of steps) {
    try { await step(); }
    catch (error) { errors.push(error); }
  }
  if (errors.length) throw new AggregateError(errors, 'Browser fixture cleanup failed');
}

function isKeyboard(event) {
  return event.kind.startsWith('keyboard.');
}

function verifyPhysicalAction(event, request) {
  const { name, metadata, sourceId, issuedAt, receipt } = request;
  const timestamp = Date.parse(event.timestamp);
  assert.ok(timestamp >= issuedAt && timestamp <= receipt.keyDownAt,
    'native action timestamp must belong to this physical request');
  assert.equal(event.kind, name === 'return' ? 'keyboard.submit' : 'keyboard.shortcut');
  assert.deepEqual(event.keyboard?.target, { role: 'AXTextField' });
  assert.deepEqual(event.keyboard.modifiers, name === 'shortcut' ? ['control'] : []);
  assert.equal(event.keyboard.keyEquivalent, metadata ? undefined : name === 'return' ? 'return' : 'a');
  assert.equal(event.contentState, metadata ? 'metadataOnly' : 'available');
  assert.equal(event.sourceId, sourceId);
  assert.equal(event.ax, undefined);
  assert.equal(event.selection, undefined);
}

function reconcilePhysicalActions(events, accepted) {
  const actions = events.filter(isKeyboard);
  assert.equal(actions.length, accepted.length, 'sealed store must contain exactly one action per accepted request');
  for (const [index, request] of accepted.entries()) {
    verifyPhysicalAction(actions[index], request);
    assert.deepEqual(actions[index], request.event, 'sealed action must equal the witnessed action');
  }
}

test('physical action timestamps belong to the current request and receipt', () => {
  const issuedAt = Date.parse('2026-09-16T00:00:00Z');
  const request = {
    name: 'return', metadata: false, sourceId: 'source-one', issuedAt,
    receipt: { keyDownAt: issuedAt + 50 },
  };
  const event = {
    kind: 'keyboard.submit', contentState: 'available', sourceId: request.sourceId,
    timestamp: new Date(issuedAt + 20).toISOString(),
    keyboard: { target: { role: 'AXTextField' }, modifiers: [], keyEquivalent: 'return' },
  };
  for (const time of [issuedAt, issuedAt + 20, request.receipt.keyDownAt]) {
    verifyPhysicalAction({ ...event, timestamp: new Date(time).toISOString() }, request);
  }
  for (const timestamp of [
    new Date(issuedAt - 1).toISOString(),
    new Date(request.receipt.keyDownAt + 1).toISOString(),
    'invalid',
  ]) {
    assert.throws(() => verifyPhysicalAction({ ...event, timestamp }, request), /timestamp/);
  }
  assert.throws(() => verifyPhysicalAction(event, {
    ...request, receipt: { keyDownAt: issuedAt - 1 },
  }), /timestamp/);
});

test('sealed physical ledger rejects stale, duplicate, missing, reordered and denied actions', () => {
  const issuedAt = Date.parse('2026-09-16T00:00:00Z');
  const first = {
    id: 1, kind: 'keyboard.submit', contentState: 'available', sourceId: 'source-one',
    timestamp: new Date(issuedAt + 20).toISOString(),
    keyboard: { target: { role: 'AXTextField' }, modifiers: [], keyEquivalent: 'return' },
  };
  const second = {
    id: 3, kind: 'keyboard.shortcut', contentState: 'metadataOnly', sourceId: 'source-two',
    timestamp: new Date(issuedAt + 220).toISOString(),
    keyboard: { target: { role: 'AXTextField' }, modifiers: ['control'] },
  };
  const accepted = [
    { name: 'return', metadata: false, sourceId: first.sourceId, issuedAt,
      receipt: { keyDownAt: issuedAt + 50 }, event: first },
    { name: 'shortcut', metadata: true, sourceId: second.sourceId, issuedAt: issuedAt + 200,
      receipt: { keyDownAt: issuedAt + 250 }, event: second },
  ];
  reconcilePhysicalActions([
    first, { id: 2, kind: 'ui.changed' }, second,
  ], accepted);
  const denied = { ...second, id: 4, timestamp: new Date(issuedAt + 120).toISOString() };
  for (const [label, rows] of [
    ['stale', [{ ...first, timestamp: new Date(issuedAt - 1).toISOString() }, second]],
    ['fresh-ID duplicate', [first, second, { ...second, id: 4 }]],
    ['missing', [first]],
    ['reordered', [second, first]],
    ['denied extra', [first, denied, second]],
    ['denied replacement', [first, denied]],
    ['changed sealed identity', [first, { ...second, id: 4 }]],
    ['metadata text leak', [first, { ...second, keyboard: { ...second.keyboard, keyEquivalent: 'a' } }]],
  ]) {
    assert.throws(() => reconcilePhysicalActions(rows, accepted), assert.AssertionError, label);
  }
});

test('cleanup attempts every step in order before reporting all failures', async () => {
  const markerError = new Error('marker write failed');
  const closeError = new Error('browser close failed');
  const attempted = [];
  await assert.rejects(cleanupAll([
    () => { attempted.push('marker'); throw markerError; },
    async () => {
      attempted.push('browser-close');
      await Promise.resolve();
      attempted.push('browser-settled');
      throw closeError;
    },
    () => { attempted.push('server-close'); },
    async () => { await Promise.resolve(); attempted.push('evidence-close'); },
  ]), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, [markerError, closeError]);
    assert.deepEqual(attempted, [
      'marker', 'browser-close', 'browser-settled', 'server-close', 'evidence-close',
    ]);
    return true;
  });
  await cleanupAll([() => { attempted.push('finished'); }]);
  assert.equal(attempted.at(-1), 'finished');
});

// CDP drives only the fixture. It never supplies text or accessibility data to
// native capture, and does not enable Chromium's accessibility implementation.
async function connect(url, port) {
  const address = new URL(url);
  assert.equal(address.protocol, 'ws:');
  assert.equal(address.hostname, '127.0.0.1');
  assert.equal(address.port, String(port));
  const socket = new WebSocket(address);
  const pending = new Map();
  let sequence = 0;
  const rejectPending = () => {
    for (const item of pending.values()) item.reject(new Error('Fixture CDP connection closed'));
    pending.clear();
  };
  socket.addEventListener('close', rejectPending);
  socket.addEventListener('error', rejectPending);
  socket.addEventListener('message', ({ data }) => {
    const value = JSON.parse(data);
    const item = pending.get(value.id);
    if (!item) return;
    pending.delete(value.id);
    if (value.error) item.reject(new Error(JSON.stringify(value.error)));
    else item.resolve(value.result);
  });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Fixture CDP connect timeout')), 5_000);
      socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error('Fixture CDP connect failed'));
      }, { once: true });
    });
  } catch (error) {
    socket.close();
    throw error;
  }
  return {
    close: () => socket.close(),
    call: (method, params = {}) => new Promise((resolve, reject) => {
      if (socket.readyState !== WebSocket.OPEN) {
        reject(new Error('Fixture CDP is not open'));
        return;
      }
      const id = ++sequence;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Fixture CDP timeout: ${method}`));
      }, 5_000);
      pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      socket.send(JSON.stringify({ id, method, params }));
    }),
  };
}

test(physicalMode ? 'real Edge recorder accepts only admitted physical keyboard evidence' :
  'real Edge snapshots preserve useful bodies and reject denied synthetic contexts', {
  skip: optedIn ? false : 'requires MAKA_HISTORY_WINDOWS_BROWSER_TEST=1',
  timeout: 240_000,
}, async (t) => {
  assert.equal(process.platform, 'win32', 'run in an unlocked Windows interactive session');
  assert.equal(Number(process.versions.node.split('.')[0]), 24, 'use Node 24');
  for (const path of [helper, edge]) assert.ok(isAbsolute(path), 'executable paths must be absolute');
  const parent = process.env.MAKA_HISTORY_WINDOWS_TEST_ROOT ?? tmpdir();
  assert.match(parent, /^[a-z]:\\/i, 'test root must be on a local drive');
  if (physicalMode) {
    assert.ok(inputRequestPath && /^[a-z]:\\/i.test(inputRequestPath), 'physical mode requires a local absolute driver request path');
    closeSync(openSync(inputRequestPath, 'wx'));
  }
  const root = await mkdtemp(join(parent, 'maka-history-browser-'));
  const evidencePath = join(root, 'evidence.jsonl');
  const fd = openSync(evidencePath, 'wx');
  const started = performance.now();
  const workDeadline = physicalMode ? started + 200_000 : Infinity;
  const token = randomUUID().replaceAll('-', '');
  const home = join(root, 'history');
  let browser;
  let server;
  let port;
  let usefulBaseline = false;
  const lifecycleErrors = [];
  const pages = new Map();
  const deniedMarkers = new Set();
  const prefix = `/${token}/`;

  async function until(check, label, timeout) {
    return pollUntil(async () => {
      assert.ok(performance.now() < workDeadline, '200-second browser physical work budget exhausted');
      return check();
    }, label, timeout);
  }

  function evidence(type, values = {}) {
    writeSync(fd, `${JSON.stringify({
      type, at: new Date().toISOString(), elapsedMs: Math.round(performance.now() - started), ...values,
    })}\n`);
  }

  async function stopBrowser() {
    if (!browser) return;
    const owned = browser;
    browser = undefined;
    await cleanupAll([
      async () => {
        if (owned.control && owned.child.exitCode === null) {
          try { await owned.control.call('Browser.close'); }
          catch (error) { evidence('browser.close-response', { message: error.message }); }
        }
      },
      () => owned.page?.close(),
      () => owned.control?.close(),
      async () => {
        if (owned.child.exitCode === null && !owned.error) {
          try { await pollUntil(() => owned.exited, 'isolated Edge exit', 5_000); }
          catch {
            // Only the still-owned fresh-profile process tree, never all Edge PIDs.
            await run('taskkill.exe', ['/PID', String(owned.child.pid), '/T', '/F'], {
              windowsHide: true, timeout: 5_000,
            });
            await pollUntil(() => owned.exited, 'terminated fixture exit', 3_000);
            throw new Error('Isolated Edge required forced termination');
          }
        }
      },
      () => evidence('browser.closed', { pid: owned.child.pid, code: owned.child.exitCode }),
    ]);
  }

  t.after(async () => {
    await cleanupAll([
      () => { if (physicalMode) writeFileSync(inputRequestPath, JSON.stringify({ done: true })); },
      () => writeFile(join(home, 'control.json'), `${JSON.stringify({ state: 'stopped', revision: token })}\n`),
      stopBrowser,
      () => server?.closeAllConnections(),
      async () => { if (server?.listening) await new Promise((resolve) => server.close(resolve)); },
      () => evidence('suite.finished', { usefulBaseline, root }),
      () => closeSync(fd),
      () => t.diagnostic(`Synthetic evidence and isolated profiles retained at ${root}`),
      () => { if (lifecycleErrors.length) throw new AggregateError(lifecycleErrors, 'Fixture lifecycle errors'); },
    ]);
  });
  evidence('suite.started', { root, helper, edge, node: process.version, forcedAccessibility: false, physicalMode });
  t.diagnostic(`Evidence: ${evidencePath}`);
  await mkdir(home);
  await writeFile(join(home, 'maka-settings.json'), '{"enabled":true}\n', { flag: 'wx' });
  await writeFile(join(home, 'control.json'), '{"state":"running","revision":"browser-canary"}\n', { flag: 'wx' });
  const launchStarted = performance.now();
  const status = await run(helper, ['status'], {
    env: { ...process.env, OPEN_COMPUTER_HISTORY_HOME: home },
    windowsHide: true, encoding: 'utf8', timeout: 30_000, maxBuffer: 256 * 1024,
  });
  assert.equal(status.stderr, '');
  assert.equal(JSON.parse(status.stdout).recorderActive, false);
  evidence('helper.launch', { durationMs: performance.now() - launchStarted, ...status });

  async function policy({ blocked = [], captureText = true } = {}) {
    const value = {
      captureText, showMenuBarIcon: false,
      observation: {
        defaultApplicationBehavior: 'do_not_observe', defaultURLBehavior: 'do_not_observe',
        allowlist: [
          { scope: 'application', bundleID: 'win32.msedge' },
          ...['localhost', '127.0.0.1'].map((urlDomain) => ({ scope: 'url', urlDomain })),
        ],
        blocklist: blocked.map((urlDomain) => ({ scope: 'url', urlDomain })),
      },
    };
    if (physicalMode) {
      const path = join(home, `config-${randomUUID()}.tmp`);
      await writeFile(path, `${JSON.stringify(value)}\n`, { flag: 'wx' });
      await rename(path, join(home, 'config.json'));
    } else await writeFile(join(home, 'config.json'), `${JSON.stringify(value)}\n`);
    evidence('policy', value);
  }
  await policy();

  function definePage(name, extra = '') {
    const value = {
      name, title: `Maka history ${token} ${name}`,
      body: `BODY_${token}_${name}`, path: `${prefix}${name}`, extra,
    };
    pages.set(value.path, value);
    return value;
  }
  const allowed = definePage('allowed');
  const navigated = definePage('navigated');
  const blocked = definePage('blocked');
  const frame = definePage('frame');
  const embedded = definePage('embedded');
  const password = definePage('password', `<label>Synthetic input <input id="editor" type="text" value="BEFORE_PASSWORD_${token}"></label>`);
  const privateTitle = definePage('title-state');
  const actualPrivate = definePage('isolated-session');
  const physicalPage = physicalMode ? definePage('physical', `
    <label>Synthetic editor one <input aria-label="Synthetic editor one" id="one" value="FIELD_ONE_${token}"></label>
    <label>Synthetic editor two <input aria-label="Synthetic editor two" id="two" value="FIELD_TWO_${token}"></label>`) : undefined;
  const plainUrl = (page, host = '127.0.0.1') => `http://${host}:${port}${page.path}`;

  server = createServer((request, response) => {
    const host = request.headers.host;
    if (![ `localhost:${port}`, `127.0.0.1:${port}` ].includes(host)) {
      response.writeHead(403).end();
      return;
    }
    const url = new URL(request.url, `http://${host}`);
    const page = pages.get(url.pathname);
    if (!page || request.method !== 'GET') {
      response.writeHead(404).end();
      return;
    }
    evidence('fixture.request', { url: url.href });
    const embeddedUrl = plainUrl(embedded, 'localhost');
    const iframe = page === frame
      ? `<iframe title="Synthetic embedded document" src="${embeddedUrl}" width="640" height="180"></iframe>` : '';
    const script = page === physicalPage ? `
      window.fixtureInput={arm:null,receipt:null};
      addEventListener('keydown',e=>{
        const arm=window.fixtureInput.arm;
        if(!arm||!e.isTrusted||e.target.id!==arm.field||e.altKey||e.metaKey||e.shiftKey||
           (arm.name==='return'?(e.key!=='Enter'||e.ctrlKey):(e.key.toLowerCase()!=='a'||!e.ctrlKey)))return;
        const keyDownAt=Date.now();
        window.fixtureInput.arm=null;
        const field=e.target;
        if(arm.switchTo)document.getElementById(arm.switchTo).focus();
        setTimeout(()=>{window.fixtureInput.receipt={
          id:arm.id,name:arm.name,trusted:e.isTrusted,keyDownAt,settledAt:Date.now(),
          field:field.id,fieldAfter:document.activeElement.id,
          control:e.ctrlKey,password:field.type==='password',
          selectionStart:field.selectionStart,selectionEnd:field.selectionEnd,length:field.value.length
        };},0);
      },true);` : page === embedded
      ? `parent.postMessage({fixture:${JSON.stringify(token)}}, 'http://127.0.0.1:${port}');`
      : `window.fixtureFrameLoaded=false;addEventListener('message',e=>{
          if(e.origin==='http://localhost:${port}'&&e.data?.fixture===${JSON.stringify(token)})
            window.fixtureFrameLoaded=true;
        });`;
    response.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
      'Content-Security-Policy': `default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; frame-src http://localhost:${port}; base-uri 'none'; form-action 'none'`,
      'Referrer-Policy': 'no-referrer',
    });
    response.end(`<!doctype html><html lang="en"><head><title>${page.title}</title>
      <style>body{font:20px sans-serif;margin:24px}input{font:20px sans-serif}iframe{display:block}</style>
      <script>${script}</script></head><body><main><h1>Synthetic history test</h1>
      <p id="body">${page.body}</p>${page.extra}${iframe}</main></body></html>`);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  port = server.address().port;
  evidence('fixture.listening', { host: '127.0.0.1', port });

  async function startBrowser(page, inPrivate = false) {
    const profile = join(root, `edge-profile-${randomUUID().replaceAll('-', '')}`);
    await mkdir(profile);
    const args = [
      `--user-data-dir=${profile}`, '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1',
      '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
      '--disable-component-update', '--disable-sync', '--disable-gpu', '--new-window',
      ...(inPrivate ? ['--inprivate'] : []), plainUrl(page),
    ];
    const child = spawn(edge, args, { windowsHide: false, stdio: 'ignore' });
    const owned = { child, profile, inPrivate, exited: false };
    browser = owned;
    child.once('error', (error) => { owned.error = error; });
    child.once('exit', (code, signal) => {
      owned.exited = true;
      try { evidence('browser.exit', { pid: child.pid, code, signal }); }
      catch (error) { lifecycleErrors.push(error); }
    });
    evidence('browser.spawn', { pid: child.pid, profile, args });
    const endpoint = await until(async () => {
      if (owned.error) throw owned.error;
      assert.equal(owned.exited, false, 'fresh-profile Edge exited during startup');
      try {
        const lines = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).trim().split(/\r?\n/);
        if (lines.length < 2) return undefined;
        assert.match(lines[0], /^\d+$/);
        assert.match(lines[1], /^\/devtools\/browser\/[a-z0-9-]+$/i);
        return { port: Number(lines[0]), path: lines[1] };
      } catch (error) {
        if (error.code === 'ENOENT' || error.code === 'EBUSY') return undefined;
        throw error;
      }
    }, 'isolated Edge DevToolsActivePort', 20_000);
    const address = `http://127.0.0.1:${endpoint.port}`;
    const version = await (await fetch(`${address}/json/version`, { signal: AbortSignal.timeout(3_000) })).json();
    evidence('browser.version', version);
    owned.control = await connect(`ws://127.0.0.1:${endpoint.port}${endpoint.path}`, endpoint.port);
    const target = await until(async () => {
      const response = await fetch(`${address}/json/list`, { signal: AbortSignal.timeout(3_000) });
      assert.ok(response.ok);
      const targets = await response.json();
      return targets.find((item) => item.type === 'page' && item.url === plainUrl(page));
    }, 'synthetic page target', 15_000);
    owned.page = await connect(target.webSocketDebuggerUrl, endpoint.port);
    await owned.page.call('Page.enable');
  }

  async function evaluate(expression) {
    const value = await browser.page.call('Runtime.evaluate', { expression, returnByValue: true });
    assert.equal(value.exceptionDetails, undefined, 'synthetic readiness expression failed');
    return value.result.value;
  }

  async function window(page, focus = false) {
    assert.equal(browser.exited, false, 'test Edge process exited');
    const { stdout } = await run('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', fixture,
      '-BrowserProcessId', String(browser.child.pid), '-ParentProcessId', String(process.pid),
      '-Profile', browser.profile, '-Executable', edge, '-Title', page.title,
      ...(focus ? ['-Focus'] : []), ...(browser.inPrivate ? ['-InPrivate'] : []),
    ], { windowsHide: true, encoding: 'utf8', timeout: 8_000, maxBuffer: 128 * 1024 });
    const state = JSON.parse(stdout.trim());
    assert.equal(state.processIdentifier, browser.child.pid);
    assert.ok(Number.isSafeInteger(state.windowID) && state.windowID > 0);
    evidence('fixture.window', state);
    return state;
  }

  async function navigate(page, url = plainUrl(page)) {
    const parsed = new URL(url);
    assert.ok(['localhost', '127.0.0.1'].includes(parsed.hostname));
    assert.equal(parsed.port, String(port));
    assert.ok(pages.has(parsed.pathname));
    const navigation = await browser.page.call('Page.navigate', { url });
    assert.equal(navigation.errorText, undefined, 'synthetic navigation failed');
    await until(() => evaluate(`document.readyState==='complete'
      &&location.href===${JSON.stringify(url)}
      &&document.title===${JSON.stringify(page.title)}
      &&document.querySelector('#body')?.textContent===${JSON.stringify(page.body)}
      ${page === frame ? '&&window.fixtureFrameLoaded===true' : ''}
      ${page === password ? "&&document.querySelector('#editor')?.type==='text'&&document.querySelector('#editor').getBoundingClientRect().height>0" : ''}`),
    `rendered ${page.name}`);
    await browser.page.call('Page.bringToFront');
    return window(page, true);
  }

  async function snapshot(page, target) {
    const source = randomUUID();
    const args = [
      'snapshot', '--parent-pid', String(process.pid), '--window', String(target.windowID),
      '--pid', String(target.processIdentifier), '--source', source,
    ];
    const commandStarted = performance.now();
    let result;
    try {
      // execFile directly spawns native: --parent-pid really is this Node PID.
      result = await run(helper, args, {
        env: { ...process.env, OPEN_COMPUTER_HISTORY_HOME: home },
        windowsHide: true, encoding: 'utf8', timeout: 5_000, maxBuffer: 256 * 1024,
      });
      evidence('native.result', { page: page.name, args, ...result, durationMs: performance.now() - commandStarted });
    } catch (error) {
      evidence('native.error', {
        page: page.name, args, code: error.code, signal: error.signal, killed: error.killed,
        stdout: error.stdout, stderr: error.stderr, message: error.message,
        durationMs: performance.now() - commandStarted,
      });
      throw error; // A timeout/provider failure is not a successful suppression.
    }
    for (const marker of deniedMarkers) {
      assert.ok(!result.stdout.includes(marker) && !result.stderr.includes(marker), 'denied fixture marker escaped');
    }
    assert.equal(result.stderr, '');
    const final = await window(page);
    assert.equal(final.windowID, target.windowID);
    const value = JSON.parse(result.stdout);
    if (value) {
      assert.equal(value.pid, target.processIdentifier);
      assert.equal(value.windowId, target.windowID);
      assert.equal(value.appId, 'win32.msedge');
      assert.equal(value.sourceId, source);
      assert.equal(value.sourceKnown, true);
      assert.equal(value.secure, false);
      assert.equal(value.private, false);
      assert.ok(value.domains.every((domain) => ['127.0.0.1', 'localhost'].includes(domain)));
    }
    return value;
  }

  function useful(value, page, host = '127.0.0.1') {
    assert.ok(value, 'allowed real Edge page was suppressed; browser source/body coverage is missing');
    assert.ok(value.text?.includes(page.body), 'snapshot must contain real body text, not only title/toolbar');
    assert.ok(!value.title.includes(page.body));
    assert.ok(value.domains.includes(host), 'Document must expose its own admitted origin');
    assert.equal(value.url, `http://${host}:${port}/`);
  }

  async function admitted(page, target) {
    return until(() => snapshot(page, target), `accessible ${page.name} document`, 6_000);
  }

  async function scenario(name, action) {
    await t.test(name, async () => {
      evidence('case.started', { name });
      try {
        await action();
        evidence('case.passed', { name });
      } catch (error) {
        evidence('case.failed', { name, message: error.message, stack: error.stack });
        throw error;
      }
    });
  }

  if (physicalMode) {
    await scenario('physical browser keys, revocation, privacy and sealed recovery', recorderCase);
    return;
  }
  await startBrowser(allowed);
  await scenario('allowed document exposes useful body without forcing accessibility', async () => {
    const target = await navigate(allowed);
    // Native accessibility initialization is asynchronous. Re-query the same
    // window without navigation, injected flags or a separate warm-up client.
    const value = await until(() => snapshot(allowed, target), 'cold browser body', 12_000);
    useful(value, allowed);
    usefulBaseline = true;
  });
  await scenario('same-origin navigation updates text and strips URL path/query/fragment', async () => {
    const secret = `QUERY_${token}`;
    const url = `${plainUrl(navigated)}?secret=${secret}#FRAGMENT_${token}`;
    const value = await admitted(navigated, await navigate(navigated, url));
    useful(value, navigated);
    const serialized = JSON.stringify(value);
    for (const excluded of [allowed.body, secret, `FRAGMENT_${token}`, navigated.path]) {
      assert.ok(!serialized.includes(excluded), `stale body or URL detail escaped: ${excluded}`);
    }
  });

  for (const item of [
    { name: 'blocked top-level document', page: blocked, host: 'localhost', blocked: ['localhost'] },
    { name: 'allowed parent with blocked cross-origin iframe', page: frame, blocked: ['localhost'] },
  ]) {
    await scenario(item.name, async () => {
      await policy();
      const target = await navigate(item.page, plainUrl(item.page, item.host));
      const baseline = await admitted(item.page, target);
      useful(baseline, item.page, item.host);
      if (item.page === frame) {
        assert.ok(baseline.text.includes(embedded.body), 'allowed iframe body was not captured');
        assert.ok(baseline.domains.includes('localhost'), 'iframe origin was not attributed');
      }
      evidence('case.allowed-control', { name: item.name });
      await policy({ blocked: item.blocked });
      const deniedTarget = await navigate(item.page, plainUrl(item.page, item.host));
      assert.equal(await snapshot(item.page, deniedTarget), null, 'denied context must not return even a title');
      assert.ok(usefulBaseline, 'null is inconclusive: allowed baseline did not expose usable browser content');
      await policy();
      if (item.page === frame) {
        assert.equal(await evaluate(`(() => {
          const frame = document.querySelector('iframe');
          frame.contentWindow.focus();
          return document.activeElement === frame;
        })()`), true);
        const focused = await admitted(frame, deniedTarget);
        useful(focused, frame);
        assert.ok(focused.text.includes(embedded.body), 'focused iframe body must remain useful');
        assert.deepEqual([...focused.domains].sort(), ['127.0.0.1', 'localhost']);
        await policy({ blocked: ['127.0.0.1'] });
        assert.equal(await snapshot(frame, deniedTarget), null, 'iframe focus must not bypass its blocked parent');
        assert.equal(await evaluate("document.activeElement === document.querySelector('iframe')"), true);
        await policy();
        const recovered = await admitted(frame, deniedTarget);
        useful(recovered, frame);
        assert.ok(recovered.text.includes(embedded.body), 'focused iframe must recover after parent unblock');
        evidence('case.focused-frame-parent', { name: item.name });
      }
      useful(await admitted(allowed, await navigate(allowed)), allowed);
    });
  }
  await scenario('visible password rejects the entire snapshot', async () => {
    await policy();
    const target = await navigate(password);
    assert.equal(await evaluate(`(() => {
      window.fixtureDocument=document;
      window.fixtureInput=document.querySelector('#editor');
      return window.fixtureInput?.type==='text';
    })()`), true);
    for (const phase of [
      { name: 'before', type: 'text', value: `BEFORE_PASSWORD_${token}` },
      { name: 'denied', type: 'password', value: `SECRET_${token}` },
      { name: 'recovered', type: 'text', value: `AFTER_PASSWORD_${token}` },
    ]) {
      if (phase.type === 'password') deniedMarkers.add(phase.value);
      assert.equal(await evaluate(`(() => {
        const input=window.fixtureInput;
        if(document!==window.fixtureDocument||input!==document.querySelector('#editor')
          ||location.href!==${JSON.stringify(plainUrl(password))}) return false;
        input.value='';
        input.type=${JSON.stringify(phase.type)};
        input.value=${JSON.stringify(phase.value)};
        input.focus();
        return input.type===${JSON.stringify(phase.type)}
          &&input.value===${JSON.stringify(phase.value)}&&input.getBoundingClientRect().height>0
          &&document.title===${JSON.stringify(password.title)}
          &&document.querySelector('#body')?.textContent===${JSON.stringify(password.body)};
      })()`), true, 'password transition must retain the same document and input');
      assert.equal((await window(password)).windowID, target.windowID);
      evidence('fixture.transition', { page: password.name, ...phase });
      const value = phase.name === 'denied'
        ? await snapshot(password, target) : await admitted(password, target);
      if (phase.type === 'password') {
        assert.equal(value, null, 'password context must not return even a title');
        assert.ok(usefulBaseline, 'password suppression requires a useful normal-browser baseline');
      } else {
        useful(value, password);
        assert.ok(value.text.includes(phase.value), 'same input must expose its current plaintext value');
      }
    }
  });
  await scenario('private window title rejects the entire snapshot', async () => {
    await policy();
    const target = await navigate(privateTitle);
    assert.equal(await evaluate(`(() => {
      window.fixtureDocument=document;
      window.fixtureBody=document.querySelector('#body');
      return window.fixtureBody?.textContent===${JSON.stringify(privateTitle.body)};
    })()`), true);
    for (const phase of [
      { name: 'before', title: privateTitle.title, body: privateTitle.body },
      { name: 'denied', title: `${privateTitle.title} InPrivate`, body: `DENIED_TITLE_${token}` },
      { name: 'recovered', title: privateTitle.title, body: `RECOVERED_TITLE_${token}` },
    ]) {
      if (phase.name === 'denied') deniedMarkers.add(phase.body);
      const page = { ...privateTitle, title: phase.title, body: phase.body };
      assert.equal(await evaluate(`(() => {
        const body=window.fixtureBody;
        if(document!==window.fixtureDocument||body!==document.querySelector('#body')
          ||location.href!==${JSON.stringify(plainUrl(privateTitle))}) return false;
        body.textContent=${JSON.stringify(phase.body)};
        document.title=${JSON.stringify(phase.title)};
        return document.title===${JSON.stringify(phase.title)}
          &&body.textContent===${JSON.stringify(phase.body)}&&body.getBoundingClientRect().height>0;
      })()`), true, 'title transition must retain the same document and body element');
      assert.equal((await window(page)).windowID, target.windowID);
      evidence('fixture.transition', { page: privateTitle.name, ...phase });
      const value = phase.name === 'denied'
        ? await snapshot(page, target) : await admitted(page, target);
      if (phase.name === 'denied') {
        assert.equal(value, null, 'private-title context must not return even a title');
        assert.ok(usefulBaseline, 'private-title suppression requires a useful normal-browser baseline');
      } else {
        useful(value, page);
      }
    }
  });
  await scenario('text capture off preserves only admitted browser metadata', async () => {
    await policy({ captureText: false });
    const value = await admitted(allowed, await navigate(allowed));
    assert.ok(value, 'admitted metadata should remain available');
    assert.equal(value.text, null);
    assert.equal(value.url, `http://127.0.0.1:${port}/`);
    assert.ok(!JSON.stringify(value).includes(allowed.body));
    assert.ok(usefulBaseline, 'text-off coverage requires a working text-on baseline');
  });
  await scenario('restoring text capture recovers useful body', async () => {
    await policy();
    useful(await admitted(allowed, await navigate(allowed)), allowed);
  });
  await stopBrowser();

  await scenario('real InPrivate instance suppresses the entire snapshot', async () => {
    await policy();
    await startBrowser(actualPrivate, true);
    const target = await navigate(actualPrivate);
    assert.equal(target.inPrivate, true);
    assert.equal(await snapshot(actualPrivate, target), null);
    assert.ok(usefulBaseline, 'InPrivate suppression is inconclusive without usable normal browsing');
  });
  await scenario('snapshot-only canary never starts a recorder or creates segments', async () => {
    assert.deepEqual((await readdir(home)).sort(), ['config.json', 'control.json', 'maka-settings.json']);
  });
  await stopBrowser();

  await scenario('cold unchanged page reaches the recorder and same-window edits refresh', recorderCase);

  async function recorderCase() {
    await policy();
    const recorded = physicalMode ? physicalPage : definePage('recorded');
    await startBrowser(recorded);
    const target = await navigate(recorded);
    if (physicalMode) await evaluate("document.getElementById('one').focus()");
    const recorder = spawn(helper, ['record', '--no-prompt', '--parent-pid', String(process.pid)], {
      env: { ...process.env, OPEN_COMPUTER_HISTORY_HOME: home },
      windowsHide: true, detached: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stderr = '';
    let stdout = '';
    recorder.stdout.on('data', (chunk) => { stdout += chunk; });
    recorder.stderr.on('data', (chunk) => { stderr += chunk; });
    recorder.stdin.on('error', (error) => { lifecycleErrors.push(error); });
    const exited = new Promise((resolve, reject) => {
      recorder.once('error', reject);
      recorder.once('close', (code, signal) => resolve({ code, signal }));
    });
    let result;
    exited.then((value) => { result = value; }, () => {});
    const captureStarted = performance.now();
    let witness;
    let witnessResult;
    let witnessError;
    let witnessState;
    let witnessAt = 0;
    let witnessStderr = '';
    let inputRequest;
    let modePassed = false;
    const acceptedActions = [];
    let safetyCleanup;
    const physicalSafety = physicalMode ? setTimeout(() => {
      inputRequest = undefined;
      safetyCleanup = cleanupAll([
        () => writeFileSync(inputRequestPath, JSON.stringify({ done: true })),
        () => recorder.stdin.end(),
        () => witness?.stdin.end(),
      ]).catch((error) => { lifecycleErrors.push(error); });
    }, Math.max(1, workDeadline - performance.now())) : undefined;

    async function invoke(args) {
      const value = await run(helper, args, {
        env: { ...process.env, OPEN_COMPUTER_HISTORY_HOME: home },
        windowsHide: true, encoding: 'utf8', timeout: 5_000,
      });
      assert.equal(value.stderr, '');
      return value.stdout;
    }

    async function events(sealed = false) {
      const paths = await readdir(join(home, 'segments'), { recursive: true }).catch((error) => {
        if (error.code === 'ENOENT' && !sealed) return [];
        throw error;
      });
      const values = [];
      let files = paths.filter((path) => path.endsWith('.jsonl'));
      if (physicalMode) {
        const dated = await Promise.all(files.map(async (path) => {
          try {
            return { path, metadata: JSON.parse(await readFile(
              join(home, 'segments', dirname(path), 'metadata.json'), 'utf8',
            )) };
          } catch (error) {
            if (error.code === 'ENOENT' && !sealed) return undefined;
            throw error;
          }
        }));
        files = dated.filter(Boolean).sort((a, b) => Date.parse(a.metadata.startedAt) - Date.parse(b.metadata.startedAt) ||
          a.path.localeCompare(b.path)).map(({ path }) => path);
      }
      for (const path of files) {
        const text = await readFile(join(home, 'segments', path), 'utf8');
        if (sealed) assert.ok(text.endsWith('\n'), 'sealed JSONL must not have a partial tail');
        const records = [];
        for (const line of text.split('\n').slice(0, -1)) {
          if (line) records.push(JSON.parse(line));
        }
        if (physicalMode) assert.equal(new Set(records.map(({ id }) => id)).size, records.length);
        if (sealed) {
          const metadata = JSON.parse(await readFile(
            join(home, 'segments', dirname(path), 'metadata.json'), 'utf8',
          ));
          assert.equal(metadata.eventCount, records.length);
          assert.equal(metadata.endReason, 'finished');
          assert.ok(Number.isFinite(Date.parse(metadata.endedAt)));
          if (physicalMode) evidence('recorder.segment', { path, metadata, events: records });
        }
        for (const event of records) {
          assert.equal(event.app.bundleIdentifier, 'win32.msedge');
          assert.equal(event.app.processIdentifier, target.processIdentifier);
          assert.equal(event.window.windowID, target.windowID);
          assert.equal(event.window.url, 'http://127.0.0.1');
          if (!physicalMode || event.contentState === 'available') {
            assert.deepEqual(event.contentDomains, ['127.0.0.1']);
            assert.equal(event.contentState, 'available');
            if (!physicalMode || event.ax) assert.equal(event.ax?.mode, 'fullTree');
          } else {
            assert.equal(event.contentState, 'metadataOnly');
            assert.equal(event.contentDomains, undefined);
            assert.equal(event.ax, undefined);
            assert.equal(event.selection?.selectedText, undefined);
            assert.equal(event.keyboard?.keyEquivalent, undefined);
          }
          assert.match(event.sourceId, /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i);
          assert.ok(Number.isSafeInteger(event.id) && event.id > 0);
          assert.ok(Number.isFinite(Date.parse(event.timestamp)));
          for (const marker of deniedMarkers) assert.ok(!JSON.stringify(event).includes(marker));
          if (physicalMode) assert.doesNotMatch(JSON.stringify(event), /"(?:runtimeId|documentRuntimeId|inputTarget|uia)"/u);
        }
        values.push(...records);
      }
      return values;
    }

    async function health(state = 'running') {
      assert.equal(result, undefined, `recorder exited: ${stderr}`);
      const value = JSON.parse(await readFile(join(home, 'runtime.json'), 'utf8'));
      assert.equal(value.processIdentifier, recorder.pid);
      assert.equal(value.captureFailures, 0, 'provider failure cannot prove suppression');
      assert.ok(!value.lastError && !value.captureError, 'recorder must remain healthy');
      return value.state === state ? value : undefined;
    }

    async function suppressions() {
      let count = 0;
      for (const name of await readdir(join(home, 'segments'))) {
        const metadata = JSON.parse(await readFile(join(home, 'segments', name, 'metadata.json'), 'utf8'));
        count += metadata.suppressedEventCount ?? 0;
      }
      return count;
    }

    async function ownedField(field, password = false) {
      return until(() => {
        if (witnessError) throw witnessError;
        assert.equal(witnessResult, undefined, `witness exited: ${witnessStderr}`);
        if (!witnessState?.valid || Date.now() - witnessAt > 750 ||
            witnessState.field !== field || witnessState.password !== password) return undefined;
        return witnessState;
      }, `fresh owned ${field} browser field`, 5_000);
    }

    async function startWitness() {
      witness = spawn('powershell.exe', [
        '-NoLogo', '-NoProfile', '-NonInteractive', '-Mta', '-ExecutionPolicy', 'Bypass', '-File', fixture,
        '-BrowserProcessId', String(browser.child.pid), '-ParentProcessId', String(process.pid),
        '-Profile', browser.profile, '-Executable', edge, '-Title', recorded.title,
        '-WitnessUrl', plainUrl(recorded),
      ], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      witness.on('error', (error) => { witnessError = error; });
      witness.stdin.on('error', (error) => { witnessError = error; });
      witness.stderr.setEncoding('utf8').on('data', (data) => { witnessStderr += data; });
      witness.on('close', (code, signal) => { witnessResult = { code, signal }; });
      const lines = createInterface({ input: witness.stdout });
      lines.on('line', (line) => {
        try {
          const value = JSON.parse(line);
          witnessState = value;
          witnessAt = value.witnessedAt ?? 0;
          if (!value.valid) {
            evidence('fixture.witness-unavailable', { message: value.error });
            return;
          }
          assert.ok(Number.isSafeInteger(witnessAt) && witnessAt <= Date.now() + 100);
          assert.equal(value.processIdentifier, target.processIdentifier);
          assert.equal(value.windowID, target.windowID);
          assert.equal(value.documentUrl, plainUrl(recorded));
          assert.ok(Number.isSafeInteger(value.inputWindowID) && value.inputWindowID > 0);
          for (const id of [value.runtimeId, value.documentRuntimeId, value.rootRuntimeId]) {
            assert.ok(Array.isArray(id) && id.length > 0 && id.length <= 32 && id.every(Number.isInteger));
          }
          if (inputRequest && Date.now() - witnessAt <= 750 &&
              value.field === inputRequest.field && value.password === inputRequest.password) {
            assert.deepEqual(value.runtimeId, inputRequest.runtimeId);
            assert.deepEqual(value.documentRuntimeId, inputRequest.documentRuntimeId);
            assert.deepEqual(value.rootRuntimeId, inputRequest.rootRuntimeId);
            assert.equal(value.inputWindowID, inputRequest.inputWindowID);
            writeFileSync(inputRequestPath, JSON.stringify({
              ...inputRequest, foreground: {
                processIdentifier: value.processIdentifier, windowID: value.windowID,
              }, witnessedAt: witnessAt,
            }));
          }
        } catch (error) { witnessError = error; }
      });
      await ownedField('one');
    }

    async function leaseIdentity(expected) {
      const source = randomUUID();
      const child = spawn(helper, [
        'snapshot-lease', '--parent-pid', String(process.pid), '--window', String(target.windowID),
        '--pid', String(target.processIdentifier), '--source', source,
      ], { env: { ...process.env, OPEN_COMPUTER_HISTORY_HOME: home },
        windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      let frame;
      let error;
      let closed;
      let errors = '';
      child.on('error', (value) => { error = value; });
      child.stdin.on('error', (value) => { error = value; });
      child.stderr.setEncoding('utf8').on('data', (data) => { errors += data; });
      child.on('close', (code, signal) => { closed = { code, signal }; });
      const lines = createInterface({ input: child.stdout });
      lines.on('line', (line) => {
        try {
          const value = JSON.parse(line);
          evidence('identity-lease.frame', { value });
          if (value.type === 'snapshot') frame = value;
        } catch (value) { error = value; }
      });
      try {
        await until(() => {
          if (error) throw error;
          assert.equal(closed, undefined, `identity lease exited: ${errors}`);
          return frame;
        }, 'native browser field identity frame', 3_000);
        assert.equal(frame.snapshot?.sourceId, source);
        assert.equal(frame.snapshot?.inputTarget?.hwnd, expected.inputWindowID);
        assert.equal(frame.snapshot.inputTarget.role, 'AXTextField');
        assert.deepEqual(frame.snapshot.inputTarget.uia?.runtimeId, expected.runtimeId);
        assert.deepEqual(frame.snapshot.inputTarget.uia?.documentRuntimeId, expected.documentRuntimeId);
        const current = await ownedField(expected.field);
        assert.equal(current.inputWindowID, expected.inputWindowID);
        assert.deepEqual(current.runtimeId, expected.runtimeId);
        assert.deepEqual(current.documentRuntimeId, expected.documentRuntimeId);
        evidence('identity-lease.matched', { authority: 'standalone-identity-only', expected });
      } finally {
        child.stdin.end();
        try { await pollUntil(() => closed, 'identity lease EOF', 3_000); }
        catch {
          child.kill();
          await pollUntil(() => closed, 'identity lease termination', 2_000);
          throw new Error('Identity lease required termination');
        } finally { lines.close(); }
        assert.deepEqual(closed, { code: 0, signal: null });
        assert.equal(errors, '');
      }
    }

    async function bodyMarker(marker) {
      const count = (await events()).length;
      await evaluate(`document.getElementById('body').textContent=${JSON.stringify(marker)}`);
      const value = await until(async () => {
        await health();
        return (await events()).slice(count).find((event) => event.ax?.text?.includes(marker));
      }, 'fresh browser recorder body', 9_000);
      evidence('recorder.body', { event: value });
      return value;
    }

    async function physical(name, field, { reject = false, password = false, switchTo, metadata = false, sourceId } = {}) {
      const identity = await ownedField(field, password);
      const since = (await events()).length;
      const suppressedBefore = reject && !switchTo ? await suppressions() : undefined;
      const id = randomUUID();
      await evaluate(`window.fixtureInput.receipt=null;window.fixtureInput.arm=${JSON.stringify({ id, name, field, switchTo })}`);
      const issuedAt = Date.now();
      const request = {
        id, name, field, password, issuedAt, deadline: issuedAt + 12_000,
        processIdentifier: target.processIdentifier, windowID: target.windowID,
        inputWindowID: identity.inputWindowID, runtimeId: identity.runtimeId,
        documentRuntimeId: identity.documentRuntimeId, rootRuntimeId: identity.rootRuntimeId,
      };
      inputRequest = request;
      evidence('driver.request', { request: inputRequest, reject, metadata });
      try {
        const receipt = await until(async () => {
          if (witnessError) throw witnessError;
          await health();
          const value = await evaluate('window.fixtureInput.receipt');
          return value?.id === id && value;
        }, `physical browser ${name} receipt`, 12_000);
        inputRequest = undefined;
        writeFileSync(inputRequestPath, JSON.stringify({ id, completed: true }));
        assert.equal(receipt.trusted, true);
        assert.equal(receipt.field, field);
        assert.equal(receipt.fieldAfter, switchTo ?? field);
        assert.equal(receipt.name, name);
        assert.equal(receipt.control, name === 'shortcut');
        assert.equal(receipt.password, password);
        assert.ok(Number.isSafeInteger(receipt.keyDownAt) && Number.isSafeInteger(receipt.settledAt));
        assert.ok(receipt.keyDownAt >= issuedAt && receipt.settledAt >= receipt.keyDownAt &&
          receipt.settledAt <= Date.now() && receipt.settledAt <= request.deadline,
        'receipt must belong to the current request interval');
        if (name === 'shortcut') {
          assert.equal(receipt.selectionStart, 0);
          assert.equal(receipt.selectionEnd, receipt.length);
          assert.ok(receipt.length > 0);
        }
        if (reject) {
          const end = performance.now() + 6_000;
          while (performance.now() < end) {
            assert.ok(await health(), 'rejection window requires a running recorder');
            const fresh = (await events()).slice(since);
            assert.ok(!fresh.some(isKeyboard), 'revoked physical browser key persisted');
            if (!switchTo) assert.equal(fresh.length, 0, 'denied browser context persisted');
            assert.ok(performance.now() < workDeadline);
            await delay(100);
          }
          if (!switchTo) assert.ok(await suppressions() > suppressedBefore, 'denial must show actual native suppression');
        } else {
          const event = await until(async () => {
            await health();
            const actions = (await events()).slice(since).filter(isKeyboard);
            assert.ok(actions.length <= 1, 'one physical request produced multiple keyboard actions');
            return actions[0];
          }, `persisted physical browser ${name}`, 9_000);
          const accepted = { ...request, metadata, sourceId, receipt, event };
          verifyPhysicalAction(event, accepted);
          acceptedActions.push(accepted);
          evidence('recorder.action', { id, receipt, event });
        }
        evidence('physical.passed', { id, name, field, reject, metadata, receipt });
      } finally {
        inputRequest = undefined;
        await cleanupAll([
          () => writeFileSync(inputRequestPath, JSON.stringify({ id, completed: true })),
          () => evaluate('window.fixtureInput.arm=null'),
        ]);
      }
    }

    async function physicalAcceptance(initial) {
      await startWitness();
      const one = await ownedField('one');
      await leaseIdentity(one);
      await physical('return', 'one', { sourceId: initial.sourceId });
      await physical('shortcut', 'one', { sourceId: initial.sourceId });
      await physical('return', 'one', { reject: true, switchTo: 'two' });
      const two = await ownedField('two');
      assert.notDeepEqual(one.runtimeId, two.runtimeId);
      assert.deepEqual(one.documentRuntimeId, two.documentRuntimeId);
      assert.deepEqual(one.rootRuntimeId, two.rootRuntimeId);
      assert.equal(one.inputWindowID, two.inputWindowID);
      const recovered = await bodyMarker(`SECOND_${token}`);
      await leaseIdentity(two);
      await physical('return', 'two', { sourceId: recovered.sourceId });
      await physical('shortcut', 'two', { sourceId: recovered.sourceId });
      const secret = `PASSWORD_ONLY_${token}`;
      const passwordBody = `PASSWORD_BODY_${token}`;
      deniedMarkers.add(secret);
      deniedMarkers.add(passwordBody);
      await evaluate(`document.getElementById('two').type='password';
        document.getElementById('two').value=${JSON.stringify(secret)};
        document.getElementById('body').textContent=${JSON.stringify(passwordBody)}`);
      assert.equal(await snapshot(recorded, target), null);
      await physical('return', 'two', { reject: true, password: true });
      await evaluate(`document.getElementById('two').value='RECOVERED_FIELD';
        document.getElementById('two').type='text';
        document.getElementById('body').textContent='Recovered synthetic document'`);
      const passwordRecovery = await bodyMarker(`PASSWORD_RECOVERED_${token}`);
      await physical('return', 'two', { sourceId: passwordRecovery.sourceId });
      await policy({ blocked: ['127.0.0.1'] });
      assert.equal(await snapshot(recorded, target), null);
      const blockedBody = `DOMAIN_ONLY_${token}`;
      deniedMarkers.add(blockedBody);
      await evaluate(`document.getElementById('body').textContent=${JSON.stringify(blockedBody)}`);
      await physical('return', 'two', { reject: true });
      await evaluate("document.getElementById('body').textContent='Allowed synthetic document'");
      await policy();
      const domainRecovery = await bodyMarker(`DOMAIN_RECOVERED_${token}`);
      await physical('return', 'two', { sourceId: domainRecovery.sourceId });
      await invoke(['pause']);
      await until(() => health('paused'), 'paused browser recorder', 9_000);
      await policy({ captureText: false });
      const off = `TEXT_OFF_ONLY_${token}`;
      deniedMarkers.add(off);
      await evaluate(`document.getElementById('body').textContent=${JSON.stringify(off)};
        document.getElementById('two').value=${JSON.stringify(off)}`);
      const metadataSince = (await events()).length;
      await invoke(['resume']);
      await until(() => health(), 'metadata browser recorder', 9_000);
      const metadataObservation = await until(async () => {
        await health();
        return (await events()).slice(metadataSince).find((event) =>
          event.contentState === 'metadataOnly' &&
          ['window.changed', 'ui.changed', 'selection.changed'].includes(event.kind));
      }, 'fresh persisted metadata-only browser observation', 9_000);
      evidence('recorder.metadata-ready', { event: metadataObservation });
      await physical('return', 'two', { metadata: true, sourceId: metadataObservation.sourceId });
      await physical('shortcut', 'two', { metadata: true, sourceId: metadataObservation.sourceId });
      await invoke(['pause']);
      await until(() => health('paused'), 'paused before text restoration', 9_000);
      const metadataEvents = (await events()).slice(metadataSince);
      for (const event of metadataEvents) {
        assert.equal(event.contentState, 'metadataOnly');
        assert.equal(event.ax, undefined);
        assert.equal(event.contentDomains, undefined);
        assert.equal(event.selection?.selectedText, undefined);
        assert.equal(event.keyboard?.keyEquivalent, undefined);
      }
      evidence('recorder.metadata-only', { events: metadataEvents });
      await evaluate("document.getElementById('two').value='Restored field';document.getElementById('body').textContent='Restored body'");
      await policy();
      await invoke(['resume']);
      await until(() => health(), 'restored browser recorder', 9_000);
      const consentRecovery = await bodyMarker(`CONSENT_RECOVERED_${token}`);
      await physical('return', 'two', { sourceId: consentRecovery.sourceId });
      modePassed = true;
    }
    try {
      const initial = await until(async () => {
        assert.equal(result, undefined, `recorder exited: ${stderr}`);
        return (await events()).find((value) => value.ax?.text?.includes(recorded.body));
      }, 'recorder cold body', 25_000);
      evidence('recorder.cold-body', { durationMs: performance.now() - captureStarted, event: initial });
      if (physicalMode) {
        assert.equal(initial.contentState, 'available');
        assert.equal(initial.ax?.mode, 'fullTree');
        assert.ok(!initial.window.title.includes(recorded.body));
        usefulBaseline = true;
        await physicalAcceptance(initial);
      } else {
        const changed = `RECORDED_EDIT_${token}`;
        const editStarted = performance.now();
        await evaluate(`document.querySelector('#body').textContent=${JSON.stringify(changed)}`);
        const fresh = await until(async () => {
          assert.equal(result, undefined, `recorder exited: ${stderr}`);
          return (await events()).find((value) => value.ax.text.includes(changed));
        }, 'recorder same-window edit', 9_000);
        assert.equal(fresh.sourceId, initial.sourceId);
        assert.ok(!fresh.ax.text.includes(recorded.body), 'updated body must not retain replaced text');
        assert.ok(Date.parse(fresh.timestamp) > Date.parse(initial.timestamp));
        assert.equal((await window(recorded)).windowID, target.windowID);
        evidence('recorder.edited-body', { durationMs: performance.now() - editStarted, event: fresh });
      }
    } finally {
      clearTimeout(physicalSafety);
      inputRequest = undefined;
      await cleanupAll([
        () => safetyCleanup,
        () => { if (physicalMode) writeFileSync(inputRequestPath, JSON.stringify({ done: true })); },
        () => witness?.stdin.end(),
        () => recorder.stdin.end(),
        async () => {
          try { await pollUntil(() => result, 'recorder graceful exit', 5_000); }
          catch {
            recorder.kill();
            await pollUntil(() => result, 'terminated recorder exit', 1_000);
            throw new Error('Recorder needed forced termination');
          }
        },
        async () => {
          if (witness) {
            try { await pollUntil(() => witnessResult, 'browser witness EOF', 3_000); }
            catch {
              witness.kill();
              await pollUntil(() => witnessResult, 'browser witness termination', 2_000);
              throw new Error('Browser witness required termination');
            }
            assert.deepEqual(witnessResult, { code: 0, signal: null });
            assert.equal(witnessStderr, '');
          }
        },
        () => {
          assert.deepEqual(result, { code: 0, signal: null });
          assert.equal(stdout, '');
          assert.equal(stderr, '');
          if (lifecycleErrors.length) throw new AggregateError(lifecycleErrors, 'Fixture lifecycle errors');
          evidence('recorder.closed', { ...result, stdout, stderr });
        },
      ]);
    }
    const sealedEvents = await events(true);
    assert.ok(sealedEvents.length >= 2, 'sealed store must retain both observed bodies');
    if (physicalMode) {
      reconcilePhysicalActions(sealedEvents, acceptedActions);
      evidence('recorder.actions-reconciled', { accepted: acceptedActions.map(({ id }) => id) });
    }
    const runtime = JSON.parse(await readFile(join(home, 'runtime.json'), 'utf8'));
    assert.equal(runtime.state, 'stopped');
    assert.equal(runtime.captureFailures, 0);
    assert.ok(Number.isFinite(Date.parse(runtime.endedAt)));
    const closed = await run(helper, ['status'], {
      env: { ...process.env, OPEN_COMPUTER_HISTORY_HOME: home },
      windowsHide: true, encoding: 'utf8', timeout: 5_000,
    });
    assert.equal(closed.stderr, '');
    assert.equal(JSON.parse(closed.stdout).recorderActive, false);
    evidence('recorder.sealed', { runtime, status: JSON.parse(closed.stdout) });
    if (physicalMode) evidence('physical.acceptance', { passed: modePassed, sealed: true, cleanupVerified: true });
  }
});
