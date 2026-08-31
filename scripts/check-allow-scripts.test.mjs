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

import { findStaleAllowScripts } from './check-allow-scripts.mjs';

test('accepts exact allowScripts entries at top-level and nested lockfile paths', () => {
  assert.deepEqual(
    findStaleAllowScripts(
      {
        'esbuild@0.28.2': true,
        '@scope/tool@1.2.3': true,
      },
      {
        'node_modules/esbuild': { version: '0.28.2' },
        'node_modules/parent/node_modules/@scope/tool': { version: '1.2.3' },
      },
    ),
    [],
  );
});

test('reports removed, malformed, and version-bumped allowScripts entries', () => {
  assert.deepEqual(
    findStaleAllowScripts(
      {
        'esbuild@0.27.7': true,
        'removed-package@1.0.0': true,
        malformed: true,
      },
      { 'node_modules/esbuild': { version: '0.28.2' } },
    ),
    ['esbuild@0.27.7', 'removed-package@1.0.0', 'malformed'],
  );
});
