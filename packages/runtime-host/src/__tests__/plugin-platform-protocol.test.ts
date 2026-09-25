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
import { test } from 'node:test';
import {
  decodePluginPlatformChangedFrame,
  PLUGIN_PLATFORM_OPERATION_SPECS,
} from '../protocol/plugin-platform.js';

const decode = PLUGIN_PLATFORM_OPERATION_SPECS['plugin.platform.query'].decodeOutput;

test('native platform invalidations retain their sequence and reject malformed frames', () => {
  const notice = { kind: 'plugin.platform.changed', revision: 7 };
  assert.deepEqual(decodePluginPlatformChangedFrame(notice), notice);
  for (const patch of [
    { revision: -1 },
    { revision: Number.MAX_SAFE_INTEGER + 1 },
    { revision: '7' },
    { kind: 'plugin.terminal.changed' },
    { extra: true },
  ]) {
    assert.throws(() => decodePluginPlatformChangedFrame({ ...notice, ...patch }));
  }
});

const entry = {
  id: 'consumer',
  rootId: 'profile',
  packageId: 'example.consumer',
  config: null,
  disabled: true,
  status: 'disabled',
  waitingFor: [],
  effects: [],
  children: [],
};

test('platform clients preserve native management facts without confusing local and effective state', () => {
  const native = {
    ...entry,
    baseGeneration: 17,
    localDisabled: false,
    inject: { cache: { optional: true } },
    isolate: { cache: 'shared-notes' },
    intercept: {},
    requiredServices: ['cache'],
  };
  const page = { view: 'entries', items: [native], nextCursor: null };
  assert.deepEqual(decode(page), page);
  const unknown = { ...native, requiredServices: null };
  assert.deepEqual(decode({ ...page, items: [unknown] }), { ...page, items: [unknown] });
  const packages = {
    view: 'packages',
    nextCursor: null,
    items: [
      {
        extensionId: 'example.consumer',
        contentDigest: `sha256-${'a'.repeat(64)}`,
        displayName: 'Consumer',
        dependencies: [],
        structuralDependencies: [],
        requiredBy: [],
        baseGeneration: 17,
        hasRuntime: true,
        hasClient: false,
        hasComposition: true,
      },
    ],
  };
  assert.deepEqual(decode(packages), packages);
});

test('older platform inspections remain readable and malformed management facts are rejected', () => {
  const old = { view: 'entries', items: [entry], nextCursor: null };
  assert.deepEqual(decode(old), old);
  for (const patch of [
    { baseGeneration: -1 },
    { localDisabled: 'false' },
    { requiredServices: false },
    { requiredServices: [''] },
    { isolate: { cache: false } },
    { inject: null },
  ]) {
    assert.throws(() => decode({ ...old, items: [{ ...entry, ...patch }] }));
  }
});
