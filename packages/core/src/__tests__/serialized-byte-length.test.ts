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
import { serializedByteLength } from '../serialized-byte-length.js';

test('counts the bounded JSON representation used at the tool boundary', () => {
  let inspectedPastLimit = false;
  const trailing = Object.defineProperty({}, 'value', {
    enumerable: true,
    get: () => {
      inspectedPastLimit = true;
      throw new Error('must not inspect values after the byte limit');
    },
  });

  assert.equal(serializedByteLength('\0'.repeat(10)), 62);
  assert.equal(serializedByteLength(['x'.repeat(128), trailing], 32), 33);
  assert.equal(inspectedPastLimit, false);
});

test('agrees with JSON.stringify on the payloads validation bounds', () => {
  const payloads: unknown[] = [
    { fileSystem: { entries: [{ path: '/tmp/工作区', scope: 'subtree', access: 'write' }] } },
    { network: { enabled: true } },
    { kind: 'managed', profile: { roots: [] }, revision: 3 },
    // Every two-byte escape, so dropping one from the escape set and falling
    // back to \\uXXXX shows up as a byte-count disagreement.
    { text: 'tab\tnewline\nreturn\rbackspace\bformfeed\fquote"backslash\\ emoji😀 lone\ud800' },
    [],
    {},
  ];

  for (const payload of payloads) {
    assert.equal(
      serializedByteLength(payload),
      new TextEncoder().encode(JSON.stringify(payload)).byteLength,
      JSON.stringify(payload),
    );
  }
});

test('pins the deliberate departure from JSON.stringify at the top level', () => {
  // `JSON.stringify(undefined)` is unrepresentable, but an absent result is not
  // an oversized one: four bytes conservatively bounds what callers publish in
  // its place. Reporting infinity here would read downstream as "result too
  // large".
  assert.equal(serializedByteLength(undefined), 4);
  assert.equal(serializedByteLength(null), 4);
});

test('reports values JSON cannot represent as unrepresentable', () => {
  const circular: Record<string, unknown> = {};
  circular.self = circular;

  for (const value of [
    () => 'x',
    Symbol('unserializable'),
    1n,
    circular,
    { toJSON: () => 'x' },
    new Date(0),
    new (class Instance {})(),
  ]) {
    assert.equal(serializedByteLength(value), Number.POSITIVE_INFINITY, String(value?.toString()));
  }
});
