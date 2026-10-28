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
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
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
    await writeFile(join(dir, 'index.html'), `<!doctype html><body><script type="module">
      import { Player } from '${module}';
      try {
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
        document.body.dataset.result = 'passed';
      } catch (e) { document.body.dataset.result = 'failed: ' + e.message; }
    </script>`);
    const html = execFileSync(chromium, ['--headless', '--disable-dev-shm-usage',
      '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--virtual-time-budget=1000',
      '--user-data-dir=' + join(dir, 'profile'), '--dump-dom', pathToFileURL(join(dir, 'index.html')).href],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20000, maxBuffer: 1024 * 1024 });
    assert.equal(html.match(/data-result="([^"]*)"/)?.[1], 'passed');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('stop and reset cancel owned shader frames and release old observers across reloads', { skip: !chromium }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nsh-shader-stop-'));
  try {
    const source = await readFile(new URL('./nsh.js', import.meta.url), 'utf8');
    const module = 'data:text/javascript;base64,' + Buffer.from(source + '\nexport { Player };').toString('base64');
    await writeFile(join(dir, 'index.html'), `<!doctype html><body><script type="module">
      import { Player } from '${module}';
      try {
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
        document.body.dataset.result = 'passed';
      } catch (e) { document.body.dataset.result = 'failed: ' + e.message; }
    </script>`);
    const html = execFileSync(chromium, ['--headless', '--disable-dev-shm-usage',
      '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--virtual-time-budget=1000',
      '--user-data-dir=' + join(dir, 'profile'), '--dump-dom', pathToFileURL(join(dir, 'index.html')).href],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20000, maxBuffer: 1024 * 1024 });
    assert.equal(html.match(/data-result="([^"]*)"/)?.[1], 'passed');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
