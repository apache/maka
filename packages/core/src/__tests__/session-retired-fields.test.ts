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
import test from 'node:test';
import { decodeStoredMessage, type StoredMessage } from '../session.js';

const decode = (row: Record<string, unknown>): StoredMessage =>
  decodeStoredMessage(row as unknown as Parameters<typeof decodeStoredMessage>[0]);

const turnState = { type: 'turn_state', id: 's1', turnId: 't1', ts: 1, status: 'failed' } as const;

test('decodes turn states written before partialOutputRetained was retired', () => {
  for (const retained of [true, false]) {
    assert.deepEqual(decode({ ...turnState, partialOutputRetained: retained }), turnState);
  }
  assert.deepEqual(decode({ ...turnState }), turnState);
});

test('still rejects turn-state keys no released writer produced', () => {
  assert.throws(() => decode({ ...turnState, unknownFutureKey: true }));
});
