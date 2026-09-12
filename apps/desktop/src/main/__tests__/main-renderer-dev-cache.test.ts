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
import { describe, it } from 'node:test';
import { clearDevRendererHttpCache } from '../main-renderer-dev-cache.js';

describe('dev renderer HTTP cache hygiene (issue #4775)', () => {
  it('clears the session HTTP cache before loading a Vite dev server', async () => {
    let cleared = 0;
    const session = { async clearCache() { cleared += 1; } };
    const didClear = await clearDevRendererHttpCache(session, { useDevServer: true });
    assert.equal(didClear, true);
    assert.equal(cleared, 1);
  });

  it('leaves the cache alone for packaged file:// builds', async () => {
    let cleared = 0;
    const session = { async clearCache() { cleared += 1; } };
    const didClear = await clearDevRendererHttpCache(session, { useDevServer: false });
    assert.equal(didClear, false);
    assert.equal(cleared, 0);
  });

  it('downgrades a clearCache failure to a warning instead of blocking load', async () => {
    const session = {
      async clearCache(): Promise<void> { throw new Error('cache locked'); },
    };
    const didClear = await clearDevRendererHttpCache(session, { useDevServer: true });
    assert.equal(didClear, false);
  });
});
