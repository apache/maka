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
import { invokeFocusedConversation } from '../app/conversationCommands.ts';

const appRoot = new URL('../app/', import.meta.url);
const resourceRoot = new URL('../../../../plugins/workspace/workspace-files/ui/', import.meta.url);
const native = {
  nsh: 'let tracking;\n    export const signal = initial => {\n      let value = initial;\n      const observers = new Set();\n      const read = () => { if (tracking) observers.add(tracking); return value; };\n      read.set = next => {\n        if (Object.is(value, next)) return;\n        value = next;\n        for (const observer of [...observers]) observer();\n      };\n      return read;\n    };\n    export const computed = fn => fn;\n    export const untracked = fn => { const previous = tracking; tracking = undefined; try { return fn(); } finally { tracking = previous; } };\n    export const effect = fn => {\n      let alive = true;\n      const run = () => {\n        if (!alive) return;\n        const previous = tracking;\n        tracking = run;\n        try { fn(); } finally { tracking = previous; }\n      };\n      globalThis.resourceScope.push(() => { alive = false; });\n      run();\n    };\n    export const cleanup = fn => globalThis.resourceScope.push(fn);',
  locale: `export const tr = key => key;`,
  workspaceFileState: `export const createWorkspaceFiles = (_host, options) => ({ sessionId: options.sessionId });`,
  CurrentFile: `export const createCurrentFile = (_host, target) => ({target, activate() {}, suspend() {}, dispose() {this.disposed = true;}});`,
  terminalState: `export const createTerminals = (_host, options) => ({sessionId: options.sessionId});`,
};
const hooks = registerHooks({
  resolve(specifier, context, next) {
    let key = specifier;
    if (
      context.parentURL?.startsWith(resourceRoot.href) ||
      context.parentURL?.startsWith(appRoot.href)
    ) {
      for (const name of Object.keys(native)) if (specifier.endsWith('/' + name)) key = name;
      if (key in native)
        return {
          url: `data:text/javascript,${encodeURIComponent(native[key])}`,
          shortCircuit: true,
        };
      if (specifier.startsWith('.') && !/\.\w+$/.test(specifier))
        return next(`${specifier}.ts`, context);
    }
    return next(specifier, context);
  },
});
const { createResources } = await import(new URL('resources.ts', resourceRoot));
const { signal } = await import(`data:text/javascript,${encodeURIComponent(native.nsh)}`);
hooks.deregister();

function setup(t, openLink = async () => null) {
  globalThis.resourceScope = [];
  const sessions = signal(['A', 'B']);
  const errors = [];
  const resources = createResources(
    { openLink, pathLabel: (path) => path.bytesBase64 },
    {
      sessions,
      blocked: () => false,
      report: (error) => errors.push(error),
    },
  );
  const scope = globalThis.resourceScope;
  t.after(() => {
    for (const dispose of scope.toReversed()) dispose();
  });
  return { resources, sessions, errors };
}
const path = { bytesBase64: 'UkVBRE1FLm1k' };
const file = (sessionId) => ({ sessionId, path, title: 'README.md' });
const image = (sessionId) => ({
  source: { kind: 'attachment-image', read: { sessionId } },
  uri: 'maka://image/shared-name',
  width: 40,
  height: 30,
});

test('resource requests from both workspaces keep their source session, even for identical paths and image URIs', (t) => {
  const { resources } = setup(t);
  resources.openFile(file('A'));
  const a = resources.activeTab();
  assert.equal(a.model.target.sessionId, 'A');
  const oldClose = { sessionId: 'A', instance: resources.instance() };
  resources.openFile(file('B'));
  resources.close(oldClose);
  assert.equal(resources.shown(), true);
  assert.equal(resources.activeTab().model.target.sessionId, 'B');
  assert.equal(resources.sessionId(), 'B');
  assert.equal(a.model.disposed, true);
  resources.openFiles({ sessionId: 'B' });
  assert.equal(resources.files.sessionId(), 'B');
  resources.inventory({ sessionId: 'A', kind: 'terminals' });
  assert.equal(resources.terminals.sessionId(), 'A');
  resources.openImage(image('A'));
  resources.openImage(image('B'));
  assert.equal(resources.activeTab().image.source.read.sessionId, 'B');
});

test('external links do not change the current preview, and file links open in their originating workspace', async (t) => {
  const opened = [];
  const { resources } = setup(t, async (target) => {
    opened.push(target);
    return target.startsWith('https:') ? null : { path };
  });
  resources.openFile(file('A'));
  await resources.openLink('B', 'https://github.com/apache/maka', () => false);
  assert.equal(resources.sessionId(), 'A');
  await resources.openLink('B', 'README.md', () => false);
  assert.equal(resources.activeTab().model.target.sessionId, 'B');
  assert.deepEqual(opened, ['https://github.com/apache/maka', 'README.md']);
});

test('a late file-link result cannot replace a newer request or reopen a closed source session', async (t) => {
  let resolve;
  const { resources, sessions } = setup(
    t,
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const first = resources.openLink('A', 'README.md', () => false);
  resources.openFiles({ sessionId: 'B' });
  resolve({ path });
  await first;
  assert.equal(resources.sessionId(), 'B');
  assert.equal(resources.active(), 'files');
  const second = resources.openLink('B', 'README.md', () => false);
  sessions.set(['A']);
  sessions.set(['A', 'B']);
  resolve({ path });
  await second;
  assert.equal(resources.shown(), false);
  assert.equal(resources.sessionId(), null);
  resources.openFiles({ sessionId: 'B' });
  const third = resources.openLink('B', 'README.md', () => false);
  resources.close({ sessionId: 'B', instance: resources.instance() });
  resolve({ path });
  await third;
  assert.equal(resources.shown(), false);
});

test('preview close restores the source pane and removing that session releases its resources', (t) => {
  const { resources, sessions } = setup(t);
  const focused = [];
  resources.attachOpener('A', { focus: () => focused.push('A') });
  resources.attachOpener('B', { focus: () => focused.push('B') });
  resources.openImage(image('B'));
  resources.close({ sessionId: 'B', instance: resources.instance() });
  assert.deepEqual(focused, ['B']);
  resources.openFile(file('B'));
  const model = resources.activeTab().model;
  sessions.set(['A']);
  assert.equal(model.disposed, true);
  assert.equal(resources.shown(), false);
  assert.equal(resources.sessionId(), null);
  resources.openImage(image('B'));
  assert.equal(resources.shown(), false);
});

test('window commands follow the focused pane and stop targeting a removed pane', () => {
  let focus = 'A';
  const received = [];
  const pane = (sessionId) => ({
    focused: () => focus === sessionId,
    command: (id) => received.push({ sessionId, id }),
  });
  const a = pane('A');
  const b = pane('B');
  const menu = (id) => invokeFocusedConversation([a, b], id);
  for (const id of ['find', 'models', 'latest', 'commands']) {
    menu(id);
    focus = 'B';
    menu(id);
    focus = 'A';
  }
  assert.deepEqual(received, [
    { sessionId: 'A', id: 'find' },
    { sessionId: 'B', id: 'find' },
    { sessionId: 'A', id: 'models' },
    { sessionId: 'B', id: 'models' },
    { sessionId: 'A', id: 'latest' },
    { sessionId: 'B', id: 'latest' },
    { sessionId: 'A', id: 'commands' },
    { sessionId: 'B', id: 'commands' },
  ]);
  focus = 'B';
  invokeFocusedConversation([a], 'models');
  assert.deepEqual(received.at(-1), { sessionId: 'A', id: 'models' });
});
