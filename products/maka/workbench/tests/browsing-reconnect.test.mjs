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
import { registerHooks } from 'node:module';
import test from 'node:test';

const appRoot = new URL('../app/', import.meta.url);
const native = {
  nsh: `export const signal = initial => {
      let value = initial;
      const read = () => value;
      read.set = next => { value = next; };
      return read;
    };
    export const batch = fn => fn();
    export const host = { on: () => {} };
    export const cleanup = () => {};`,
  locale: `export const tr = key => key;`,
};
const hooks = registerHooks({
  resolve(specifier, context, next) {
    const key =
      context.parentURL?.startsWith(appRoot.href) && specifier === './locale'
        ? 'locale'
        : specifier;
    if (key in native)
      return { url: `data:text/javascript,${encodeURIComponent(native[key])}`, shortCircuit: true };
    if (
      context.parentURL?.startsWith(appRoot.href) &&
      specifier.startsWith('.') &&
      !/\.\w+$/.test(specifier)
    )
      return next(`${specifier}.ts`, context);
    return next(specifier, context);
  },
});
const { createBrowsing } = await import(new URL('browsing.ts', appRoot));
hooks.deregister();

async function flush() {
  for (let i = 0; i < 30; i++) await Promise.resolve();
}

const session = (id, title = id) => ({
  id,
  revision: 1,
  title,
  archived: false,
  pinned: false,
  activity: 'idle',
  createdAt: 1,
  updatedAt: 1,
});

function setup() {
  const streams = [];
  let projectReads = 0;
  let projects = [{ reference: { id: 'p1' }, name: 'Alpha', path: '/alpha', archived: false }];
  const host = {
    subscribe: async (endpoint, method) => {
      assert.equal(endpoint, 'agent');
      assert.equal(method, 'catalog');
      let pending = null;
      const queued = [];
      const stream = {
        closed: false,
        push(page) {
          if (pending) {
            const { resolve } = pending;
            pending = null;
            resolve(page);
          } else {
            queued.push({ ok: page });
          }
        },
        fail(reason) {
          if (pending) {
            const { reject } = pending;
            pending = null;
            reject(reason);
          } else {
            queued.push({ err: reason });
          }
        },
        next: () => {
          if (queued.length) {
            const item = queued.shift();
            return 'err' in item ? Promise.reject(item.err) : Promise.resolve(item.ok);
          }
          return new Promise((resolve, reject) => {
            pending = { resolve, reject };
          });
        },
        close: async () => {
          stream.closed = true;
        },
      };
      streams.push(stream);
      return stream;
    },
    query: async (_endpoint, method) => {
      if (method === 'projects') {
        projectReads += 1;
        return { kind: 'projects', revision: String(projectReads), projects, next: null };
      }
      throw new Error(`unexpected query: ${method}`);
    },
  };
  return {
    host,
    streams,
    get projectReads() {
      return projectReads;
    },
    setProjects(next) {
      projects = next;
    },
  };
}

test('catalog observation cancellation rebinds without surfacing a browser error or clearing sessions', async () => {
  const harness = setup();
  const browser = createBrowsing(harness.host);
  await flush();
  assert.equal(harness.streams.length, 1);

  harness.streams[0].push({
    revision: 'rev-1',
    sessions: [session('s1', 'First conversation')],
    needsYouCount: 1,
    before: null,
    after: null,
  });
  await flush();
  assert.deepEqual(
    browser.sessions().map((entry) => entry.id),
    ['s1'],
  );
  assert.equal(browser.error(), '');
  assert.equal(harness.projectReads, 1);

  harness.setProjects([
    { reference: { id: 'p1' }, name: 'Alpha', path: '/alpha', archived: false },
    { reference: { id: 'p2' }, name: 'Beta', path: '/beta', archived: false },
  ]);
  harness.streams[0].fail(new Error('agent_observation_cancelled'));
  await flush();

  assert.equal(browser.error(), '', 'reconfiguration cancellation must not flash a browser error');
  assert.deepEqual(
    browser.sessions().map((entry) => entry.id),
    ['s1'],
    'mounted sessions remain visible across rebind',
  );
  assert.equal(harness.streams.length, 2);
  assert.equal(harness.streams[0].closed, true);
  assert.equal(harness.projectReads, 2);

  harness.streams[1].push({
    revision: 'rev-2',
    sessions: [session('s1', 'First conversation'), session('s2', 'Second conversation')],
    needsYouCount: 0,
    before: null,
    after: null,
  });
  await flush();
  assert.deepEqual(
    browser.sessions().map((entry) => entry.id),
    ['s1', 's2'],
  );
  assert.equal(browser.projects().length, 2);
  assert.equal(browser.error(), '');
});

test('non-cancellation catalog failures remain visible for explicit browser refresh', async () => {
  const harness = setup();
  const browser = createBrowsing(harness.host);
  await flush();
  harness.streams[0].push({
    revision: 'rev-1',
    sessions: [session('s1')],
    needsYouCount: 0,
    before: null,
    after: null,
  });
  await flush();

  harness.streams[0].fail(new Error('agent_closed'));
  await flush();
  assert.equal(harness.streams.length, 1);
  assert.equal(browser.error(), 'Connection interrupted. Your draft is kept.');
});
