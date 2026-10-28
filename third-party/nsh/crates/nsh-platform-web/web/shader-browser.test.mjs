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

// Production shader mounting/deletion on real browser DOM and observers.
// Shader lifecycle only: no wasm or pixel/GPU output is exercised.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const candidates = [
  process.env.CHROME,
  'chromium',
  'chromium-browser',
  'google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
].filter(Boolean);
let chromium;
for (const candidate of candidates) {
  try {
    execFileSync(candidate, ['--version'], { stdio: 'ignore' });
    chromium = candidate;
    break;
  } catch {}
}

test('deleting a shader releases its canvas and observer before an ID is reused', { skip: !chromium }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nsh-shader-delete-'));
  try {
    const source = await readFile(new URL('./nsh.js', import.meta.url), 'utf8');
    const module = 'data:text/javascript;base64,' + Buffer.from(source + '\nexport { Player };').toString('base64');
    const expression = `(async () => {
      const { Player } = await import('${module}');
        const check = (value, message) => { if (!value) throw Error(message); };
        const disconnected = new Set();
        const Observer = window.IntersectionObserver;
        // Keep the browser's real observation behavior, recording cleanup.
        window.IntersectionObserver = class extends Observer {
          disconnect() { disconnected.add(this); super.disconnect(); }
        };
        for (const deferred of [false, true]) {
          const root = document.createElement('div');
          root._id = 1; root._kind = 'root';
          document.body.append(root);
          const player = Object.create(Player.prototype);
          Object.assign(player, {
            root, views: new Map([[1, root]]), mouseTracked: new Set(),
            shaderViews: new Set(), shaderFrameRequest: 0, removals: [], disappearing: [],
            changedStacks: new Set(),
            layoutAnimation: deferred ? { delete: { duration: 100 } } : null,
          });
          const mount = () => {
            player.op_c(['c', 2, 'view']);
            player.op_i(['i', 1, 2, null]);
            player.op_sh(['sh', 2, { key: 'test', words: [], slots: [], paused: true, animated: false }]);
            return player.view(2);
          };
          const old = mount(), canvas = old._shaderCanvas, observer = old._shaderObserver;
          check(canvas.parentNode === old && player.shaderViews.has(old), 'shader was not mounted');
          player.op_d(['d', 2]);
          check(!player.views.has(2), 'deleted ID remains registered');
          check(!player.shaderViews.has(old), 'deleted view remains a shader frame client');
          check(old._shader === null && old._shaderCanvas === null, 'deleted shader state survives');
          check(canvas.parentNode === null, 'deleted shader canvas survives');
          check(disconnected.has(observer), 'deleted shader observer stays connected');
          if (deferred) {
            check(old.isConnected && player.disappearing.includes(old), 'exit must keep the host, not its shader');
          } else {
            player.finishRemovals();
            check(!old.isConnected, 'immediate deletion leaves the host connected');
          }
          const replacement = mount();
          check(replacement !== old && player.view(2) === replacement, 'ID was not reused by a new view');
          check(player.shaderViews.size === 1 && player.shaderViews.has(replacement), 'old shader owns the reused ID');
          check(replacement._shaderCanvas.parentNode === replacement, 'replacement shader canvas is missing');
          check(!disconnected.has(replacement._shaderObserver), 'old cleanup disconnected the replacement');
          player.op_d(['d', 2]);
          check(player.shaderViews.size === 0, 'replacement shader frame client survives deletion');
          root.remove();
        }
        return 'passed';
    })()`;
    assert.equal(await evaluateInBrowser(dir, expression), 'passed');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

// Unlike --dump-dom, CDP awaitPromise waits for the real RAF assertions to finish.
async function evaluateInBrowser(dir, expression) {
  const child = spawn(chromium, ['--headless', '--disable-dev-shm-usage',
    '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--user-data-dir=' + join(dir, 'profile'), '--remote-debugging-pipe', 'about:blank'],
    { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
  let next = 0, buffer = '', stderr = '';
  const pending = new Map();
  const fail = (error) => {
    for (const { reject } of pending.values()) reject(error);
    pending.clear();
  };
  const closed = new Promise((resolve) => child.once('close', (code, signal) => {
    fail(new Error(`Chrome exited (${code ?? signal}): ${stderr}`));
    resolve();
  }));
  child.on('error', fail);
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (data) => { stderr = (stderr + data).slice(-16384); });
  child.stdio[3].on('error', fail);
  child.stdio[4].on('error', fail);
  child.stdio[4].on('end', () => fail(new Error('Chrome debugging pipe closed')));
  child.stdio[4].setEncoding('utf8');
  child.stdio[4].on('data', (data) => {
    buffer += data;
    let end;
    while ((end = buffer.indexOf('\0')) >= 0) {
      let message;
      try { message = JSON.parse(buffer.slice(0, end)); }
      catch (error) { fail(error); return; }
      buffer = buffer.slice(end + 1);
      const request = pending.get(message.id);
      if (!request) continue;
      pending.delete(message.id);
      if (message.error) request.reject(new Error(JSON.stringify(message.error)));
      else request.resolve(message.result);
    }
  });
  const call = (method, params, sessionId) => new Promise((resolve, reject) => {
    const id = ++next;
    pending.set(id, { resolve, reject });
    child.stdio[3].write(JSON.stringify({ id, method, params, sessionId }) + '\0');
  });
  let timer;
  try {
    return await Promise.race([
      (async () => {
        const { targetId } = await call('Target.createTarget', { url: 'about:blank' });
        const { sessionId } = await call('Target.attachToTarget', { targetId, flatten: true });
        await call('Target.activateTarget', { targetId });
        const result = await call('Runtime.evaluate', {
          expression, awaitPromise: true, returnByValue: true,
        }, sessionId);
        if (result.exceptionDetails) {
          throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
        }
        return result.result.value;
      })(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Chrome test did not finish within 20000 ms: ' + stderr)), 20000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    child.kill('SIGKILL');
    await closed;
  }
}

test('stop and reset cancel owned shader frames and release old observers across reloads', { skip: !chromium }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nsh-shader-stop-'));
  try {
    const source = await readFile(new URL('./nsh.js', import.meta.url), 'utf8');
    const module = 'data:text/javascript;base64,' + Buffer.from(source + '\nexport { Player };').toString('base64');
    const expression = `(async () => {
      const { Player } = await import('${module}');
        const check = (value, message) => { if (!value) throw Error(message); };
        const request = window.requestAnimationFrame.bind(window);
        const cancel = window.cancelAnimationFrame.bind(window);
        const requested = new Set(), fired = new Set(), cancelled = new Set();
        window.requestAnimationFrame = (callback) => {
          const id = request((time) => { fired.add(id); callback(time); });
          requested.add(id);
          return id;
        };
        window.cancelAnimationFrame = (id) => { cancelled.add(id); cancel(id); };
        const disconnected = new Set();
        const Observer = window.IntersectionObserver;
        window.IntersectionObserver = class extends Observer {
          disconnect() { disconnected.add(this); super.disconnect(); }
        };
        const root = document.createElement('div'), live = document.createElement('div');
        root._id = 1; root._kind = 'root'; root.append(live); document.body.append(root);
        const player = Object.create(Player.prototype);
        Object.assign(player, {
          root, live, views: new Map([[1, root]]), mouseTracked: new Set(),
          shaderViews: new Set(), shaderFrameRequest: 0, removals: [], disappearing: [],
          changedStacks: new Set(), fileOperations: new Map(), requests: new Map(), websockets: new Map(),
        });
        const mount = () => {
          player.op_c(['c', 2, 'view']);
          player.op_i(['i', 1, 2, null]);
          player.op_sh(['sh', 2, { key: 'test', words: [], slots: [], paused: false, animated: true }]);
          return player.view(2);
        };
        let previous = null;
        for (const action of ['stop', 'reset', 'reset']) {
          const el = mount(), canvas = el._shaderCanvas, observer = el._shaderObserver;
          check(el !== previous, 'reload reused the previous element');
          const owned = player.shaderFrameRequest;
          check(owned && requested.has(owned), 'shader owns no scheduled browser frame');
          player.shaderDirty(el);
          check(player.shaderFrameRequest === owned, 'dirty writes duplicate the frame callback');
          let unrelatedRan = false;
          const unrelated = window.requestAnimationFrame(() => { unrelatedRan = true; });
          player[action]();
          check(cancelled.has(owned), 'shader frame was not cancelled');
          check(!cancelled.has(unrelated), 'stop cancelled an unrelated callback');
          check(player.shaderFrameRequest === 0 && player.shaderViews.size === 0, 'shader work survives stop/reset');
          check(disconnected.has(observer), 'old app observer remains connected');
          check(el._shader === null && el._shaderObserver === null && canvas.parentNode === null, 'old app shader resources survive');
          // An already queued observer notification must not start a dead shader again.
          player.shaderDirty(el);
          check(player.shaderFrameRequest === 0, 'late notification restarted a stopped shader');
          await new Promise(request);
          check(unrelatedRan && !fired.has(owned), 'cancelled shader callback ran or unrelated callback was lost');
          if (action === 'stop') {
            check(el.isConnected, 'stop should not delete unrelated host DOM');
            player.reset();
          } else {
            check(!el.isConnected && player.views.size === 1, 'reset retained the previous app');
          }
          previous = el;
        }
        root.remove();
        return 'passed';
    })()`;
    assert.equal(await evaluateInBrowser(dir, expression), 'passed');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
