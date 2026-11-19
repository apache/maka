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
const { createSessionPermissions } = await import(new URL('sessionPermissions.ts', appRoot));
hooks.deregister();

test('disabling permission requests does not request grant revocation', async () => {
  const session = {
    id: 'session',
    revision: 4,
    title: 'Permission settings',
    labels: [],
    permissions: { access: 'read_only', requestPermissions: true },
  };
  const sent = [];
  const permissions = createSessionPermissions({}, session.id, async (method, input) => {
    sent.push([method, input.permissions]);
    return { kind: 'committed', session };
  });
  permissions.observe(session);

  await permissions.select({
    session,
    settings: { ...session.permissions, requestPermissions: false },
  });
  assert.deepEqual(sent, [
    [
      'metadata',
      {
        settings: { access: 'read_only', requestPermissions: false },
        revokeGrants: false,
      },
    ],
  ]);
});
