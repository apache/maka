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
import type { IpcHandler } from '../../ipc-reconnect-policy.js';
import {
  mirrorHandle,
  mirrorRemove,
  setWebBridgeMirror,
  WebBridgeRegistry,
} from '../registry.js';

const listener: IpcHandler = async () => 'first';
const replacement: IpcHandler = async () => 'second';

test('registry stores, finds, and removes channels', () => {
  const registry = new WebBridgeRegistry();
  assert.equal(registry.has('a'), false);
  registry.handle('a', listener);
  assert.equal(registry.has('a'), true);
  assert.equal(registry.get('a'), listener);
  assert.deepEqual(registry.channels(), ['a']);
  registry.removeHandler('a');
  assert.equal(registry.has('a'), false);
});

test('registry overwrites duplicates (last-active-wins)', () => {
  const registry = new WebBridgeRegistry();
  registry.handle('a', listener);
  registry.handle('a', replacement);
  assert.equal(registry.get('a'), replacement);
});

test('registry validates inputs', () => {
  const registry = new WebBridgeRegistry();
  assert.throws(() => registry.handle('', listener), /non-empty/);
  assert.throws(
    () => registry.handle('a', 'nope' as unknown as IpcHandler),
    /must be a function/,
  );
});

test('mirror queues registrations until the server starts', () => {
  setWebBridgeMirror(undefined);
  const registry = new WebBridgeRegistry();
  mirrorHandle('early', listener);
  mirrorHandle('gone', listener);
  mirrorRemove('gone');
  assert.equal(registry.has('early'), false);
  setWebBridgeMirror(registry);
  try {
    assert.equal(registry.get('early'), listener);
    assert.equal(registry.has('gone'), false);
  } finally {
    setWebBridgeMirror(undefined);
  }
});

test('mirror passes through once started', () => {
  const registry = new WebBridgeRegistry();
  setWebBridgeMirror(registry);
  try {
    mirrorHandle('live', listener);
    assert.equal(registry.get('live'), listener);
    mirrorRemove('live');
    assert.equal(registry.has('live'), false);
  } finally {
    setWebBridgeMirror(undefined);
  }
});
