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
import { confirmAfterProjectMcp } from '../../../../plugins/agent/conversations/ui/sendReceipt.ts';

const appRoot = new URL('../app/', import.meta.url);
const native = {
  nsh: `export const signal = initial => { let value = initial; const read = () => value; read.set = next => { value = next; }; return read; }; export const computed = fn => fn; export const cleanup = () => {}; export const batch = fn => fn(); export const effect = fn => fn(); export const untracked = fn => fn();`,
  locale: `export const tr = (key, values) => values ? key.replace(/\\{(\\w+)\\}/g, (_, name) => values[name]) : key; export const currentLocale = () => 'en'; export const applyLanguagePreference = () => {}; export const localizedPresentation = (presentation) => presentation;`,
};
const hooks = registerHooks({
  resolve(specifier, context, next) {
    let key = specifier;
    if (context.parentURL?.startsWith(appRoot.href) && specifier === './locale') key = 'locale';
    if (key in native)
      return { url: `data:text/javascript,${encodeURIComponent(native[key])}`, shortCircuit: true };
    if (
      specifier.endsWith('.js') &&
      (specifier.includes('/packages/plugin-sdk/src/') ||
        context.parentURL?.includes('/packages/plugin-sdk/src/'))
    )
      return next(`${specifier.slice(0, -3)}.ts`, context);
    if (
      context.parentURL?.startsWith(appRoot.href) &&
      specifier.startsWith('.') &&
      !/\.\w+$/.test(specifier)
    )
      return next(`${specifier}.ts`, context);
    return next(specifier, context);
  },
});
const { createProjectMcp } = await import(new URL('projectMcp.ts', appRoot));
hooks.deregister();

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const undecidedView = (revision) => ({
  kind: 'configuration',
  path: '/tmp/workspace/.maka/mcp.json',
  revision,
  trusted: false,
  declined: false,
  servers: [],
  disabled: [],
});

test('superseded projectMcp.check follows the latest check instead of aborting send', async () => {
  const first = deferred();
  const second = deferred();
  let calls = 0;
  const host = {
    query: () => (++calls === 1 ? first.promise : second.promise),
  };
  const mcp = createProjectMcp(host, 'session-1', async () => {
    throw new Error('unexpected control');
  });

  let abandoned = false;
  const sendPromise = confirmAfterProjectMcp(
    mcp.check,
    async () => {
      abandoned = true;
    },
    async () => 'sent-ok',
  );
  // A concurrent background check supersedes the send preflight check.
  const secondCheck = mcp.check();
  first.resolve(undecidedView('old-rev'));
  second.resolve({ ...undecidedView('trusted-rev'), trusted: true });

  const [sendResult, secondResult] = await Promise.all([sendPromise, secondCheck]);
  assert.equal(secondResult, true);
  assert.equal(abandoned, false);
  assert.deepEqual(sendResult, { kind: 'confirmed', value: 'sent-ok' });
  assert.equal(mcp.proposal(), null);
});

test('dismiss invalidates an in-flight check so a stale response cannot resurrect the banner', async () => {
  const inFlight = deferred();
  const host = { query: () => inFlight.promise };
  const mcp = createProjectMcp(host, 'session-2', async () => {
    throw new Error('unexpected control');
  });

  const pendingCheck = mcp.check();
  mcp.dismiss();
  inFlight.resolve(undecidedView('stale-rev'));

  const result = await pendingCheck;
  assert.equal(result, true);
  assert.equal(mcp.proposal(), null);
});
