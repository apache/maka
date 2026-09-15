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
import { closeSync, openSync, writeSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
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

async function until(check, label, timeout = 10_000) {
  const deadline = performance.now() + timeout;
  while (performance.now() < deadline) {
    const value = await check();
    if (value) return value;
    await delay(100);
  }
  assert.fail(`Timed out waiting for ${label}`);
}

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

test('real Edge snapshots preserve useful bodies and reject denied synthetic contexts', {
  skip: optedIn ? false : 'requires MAKA_HISTORY_WINDOWS_BROWSER_TEST=1',
  timeout: 240_000,
}, async (t) => {
  assert.equal(process.platform, 'win32', 'run in an unlocked Windows interactive session');
  assert.equal(Number(process.versions.node.split('.')[0]), 24, 'use Node 24');
  for (const path of [helper, edge]) assert.ok(isAbsolute(path), 'executable paths must be absolute');
  const parent = process.env.MAKA_HISTORY_WINDOWS_TEST_ROOT ?? tmpdir();
  assert.match(parent, /^[a-z]:\\/i, 'test root must be on a local drive');
  const root = await mkdtemp(join(parent, 'maka-history-browser-'));
  const evidencePath = join(root, 'evidence.jsonl');
  const fd = openSync(evidencePath, 'wx');
  const started = performance.now();
  const token = randomUUID().replaceAll('-', '');
  const home = join(root, 'history');
  let browser;
  let server;
  let port;
  let usefulBaseline = false;
  const pages = new Map();
  const deniedMarkers = new Set();
  const prefix = `/${token}/`;

  function evidence(type, values = {}) {
    writeSync(fd, `${JSON.stringify({
      type, at: new Date().toISOString(), elapsedMs: Math.round(performance.now() - started), ...values,
    })}\n`);
  }

  async function stopBrowser() {
    if (!browser) return;
    const owned = browser;
    browser = undefined;
    if (owned.control && owned.child.exitCode === null) {
      try { await owned.control.call('Browser.close'); }
      catch (error) { evidence('browser.close-response', { message: error.message }); }
    }
    owned.page?.close();
    owned.control?.close();
    if (owned.child.exitCode === null && !owned.error) {
      try { await until(() => owned.exited, 'isolated Edge exit', 5_000); }
      catch {
        // Only the still-owned fresh-profile process tree, never all Edge PIDs.
        await run('taskkill.exe', ['/PID', String(owned.child.pid), '/T', '/F'], {
          windowsHide: true, timeout: 5_000,
        });
        await until(() => owned.exited, 'terminated fixture exit', 3_000);
        throw new Error('Isolated Edge required forced termination');
      }
    }
    evidence('browser.closed', { pid: owned.child.pid, code: owned.child.exitCode });
  }

  t.after(async () => {
    try {
      await writeFile(join(home, 'control.json'), `${JSON.stringify({ state: 'stopped', revision: token })}\n`);
      await stopBrowser();
    } finally {
      server?.closeAllConnections();
      if (server?.listening) await new Promise((resolve) => server.close(resolve));
      evidence('suite.finished', { usefulBaseline, root });
      closeSync(fd);
      t.diagnostic(`Synthetic evidence and isolated profiles retained at ${root}`);
    }
  });
  evidence('suite.started', { root, helper, edge, node: process.version, forcedAccessibility: false });
  t.diagnostic(`Evidence: ${evidencePath}`);
  await mkdir(home);
  await writeFile(join(home, 'maka-settings.json'), '{"enabled":true}\n', { flag: 'wx' });
  await writeFile(join(home, 'control.json'), '{"state":"running","revision":"browser-canary"}\n', { flag: 'wx' });

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
    await writeFile(join(home, 'config.json'), `${JSON.stringify(value)}\n`);
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
    const script = page === embedded
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
      evidence('browser.exit', { pid: child.pid, code, signal });
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

  await startBrowser(allowed);
  await scenario('allowed document exposes useful body without forcing accessibility', async () => {
    const value = await snapshot(allowed, await navigate(allowed));
    useful(value, allowed);
    usefulBaseline = true;
  });
  await scenario('same-origin navigation updates text and strips URL path/query/fragment', async () => {
    const secret = `QUERY_${token}`;
    const url = `${plainUrl(navigated)}?secret=${secret}#FRAGMENT_${token}`;
    const value = await snapshot(navigated, await navigate(navigated, url));
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
      const baseline = await snapshot(item.page, target);
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
      useful(await snapshot(allowed, await navigate(allowed)), allowed);
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
      const value = await snapshot(password, target);
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
      const value = await snapshot(page, target);
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
    const value = await snapshot(allowed, await navigate(allowed));
    assert.ok(value, 'admitted metadata should remain available');
    assert.equal(value.text, null);
    assert.equal(value.url, `http://127.0.0.1:${port}/`);
    assert.ok(!JSON.stringify(value).includes(allowed.body));
    assert.ok(usefulBaseline, 'text-off coverage requires a working text-on baseline');
  });
  await scenario('restoring text capture recovers useful body', async () => {
    await policy();
    useful(await snapshot(allowed, await navigate(allowed)), allowed);
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
});
