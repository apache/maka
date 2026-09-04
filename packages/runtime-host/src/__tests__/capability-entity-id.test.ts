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
import { clientCapabilityEntityId } from '../capability-entity-id.js';

test('passes an already wire-safe identity through unchanged', () => {
  assert.equal(clientCapabilityEntityId('my-server-01'), 'my-server-01');
  assert.equal(clientCapabilityEntityId('my_server_01'), 'my_server_01');
});

test('normalizes spaces and punctuation into a readable label plus digest', () => {
  const id = clientCapabilityEntityId('My Server #01');
  assert.match(id, /^My_Server_01_[0-9a-f]{24}$/u);
});

test('truncates an over-long identity to a bounded label with a digest', () => {
  const value = 'x'.repeat(300);
  const id = clientCapabilityEntityId(value);
  assert.ok(id.length <= 128, `expected <=128, got ${id.length}`);
  assert.match(id, /_[0-9a-f]{24}$/u);
});

test('distinct over-long values produce distinct digests', () => {
  const a = clientCapabilityEntityId('a'.repeat(300));
  const b = clientCapabilityEntityId('b'.repeat(300));
  assert.notEqual(a, b);
});

test('honors an explicit max length', () => {
  const id = clientCapabilityEntityId('server name here', 40);
  assert.ok(id.length <= 40, `expected <=40, got ${id.length}`);
});
