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
import { VirtualWebSender, virtualInvokeEvent } from '../virtual-sender.js';

test('sender ids are negative and unique', () => {
  const delivered: Array<[string, unknown[]]> = [];
  const first = new VirtualWebSender((channel, args) => delivered.push([channel, args]));
  const second = new VirtualWebSender((channel, args) => delivered.push([channel, args]));
  assert.ok(first.id < 0 && second.id < 0 && first.id !== second.id);
  assert.equal(first.isDestroyed(), false);
});

test('send delivers until destroyed', () => {
  const delivered: Array<[string, unknown[]]> = [];
  const sender = new VirtualWebSender((channel, args) => delivered.push([channel, args]));
  sender.send('sessions:changed', { reason: 'updated' });
  assert.deepEqual(delivered, [['sessions:changed', [{ reason: 'updated' }]]]);
  sender.destroy();
  assert.equal(sender.isDestroyed(), true);
  sender.send('sessions:changed', {});
  assert.equal(delivered.length, 1);
});

test('destroyed listeners fire once on destroy', () => {
  const sender = new VirtualWebSender(() => undefined);
  let calls = 0;
  const listener = () => {
    calls += 1;
  };
  sender.once('destroyed', listener);
  sender.destroy();
  sender.destroy();
  assert.equal(calls, 1);
  // Late subscribers on a dead sender fire immediately.
  let late = 0;
  sender.once('destroyed', () => {
    late += 1;
  });
  assert.equal(late, 1);
  // off() unsubscribes.
  const live = new VirtualWebSender(() => undefined);
  let liveCalls = 0;
  const liveListener = () => {
    liveCalls += 1;
  };
  live.once('destroyed', liveListener);
  live.off('destroyed', liveListener);
  live.destroy();
  assert.equal(liveCalls, 0);
});

test('virtual invoke event carries a null frame', () => {
  const sender = new VirtualWebSender(() => undefined);
  const event = virtualInvokeEvent(sender);
  assert.equal(event.sender, sender);
  assert.equal(event.senderFrame, null);
});
