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
import { describe, test } from 'node:test';
import {
  isCanonicalRuntimeHostWebSocketPath,
  RUNTIME_HOST_WEBSOCKET_PATH_MAX_BYTES,
} from '../protocol/index.js';

describe('Runtime Host WebSocket path', () => {
  test('accepts canonical absolute paths', () => {
    assert.equal(isCanonicalRuntimeHostWebSocketPath('/'), true);
    assert.equal(isCanonicalRuntimeHostWebSocketPath('/runtime-host'), true);
    assert.equal(isCanonicalRuntimeHostWebSocketPath('/runtime-host/%E2%9C%93'), true);
  });

  test('rejects values that are not canonical same-origin paths', () => {
    const invalidPaths: unknown[] = [
      undefined,
      null,
      0,
      '',
      'runtime-host',
      '//attacker.example',
      '/runtime-host?token=secret',
      '/runtime-host#fragment',
      '/runtime-host/../admin',
      '/runtime-host\u0000',
    ];

    for (const path of invalidPaths) {
      assert.equal(isCanonicalRuntimeHostWebSocketPath(path), false);
    }
  });

  test('enforces the encoded path byte limit at the exact boundary', () => {
    // The leading slash counts toward the wire-size budget.
    const maximumPath = `/${'a'.repeat(RUNTIME_HOST_WEBSOCKET_PATH_MAX_BYTES - 1)}`;
    const oversizedPath = `${maximumPath}a`;

    assert.equal(new TextEncoder().encode(maximumPath).byteLength, 1_000);
    assert.equal(isCanonicalRuntimeHostWebSocketPath(maximumPath), true);
    assert.equal(isCanonicalRuntimeHostWebSocketPath(oversizedPath), false);
  });
});
