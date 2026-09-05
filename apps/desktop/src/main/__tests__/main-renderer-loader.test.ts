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
import { clearDevRendererCache, type MainRendererCacheOwner } from '../main-renderer-loader.js';

test('clears the renderer session cache only for a Vite development entry', async () => {
  let clearCount = 0;
  const owner: MainRendererCacheOwner = {
    webContents: {
      session: {
        async clearCache() { clearCount += 1; },
      },
    },
  };

  await clearDevRendererCache(owner, {
    filePath: '/app/dist-renderer/index.html',
    url: 'http://127.0.0.1:5173',
    useDevServer: true,
  });
  await clearDevRendererCache(owner, {
    filePath: '/app/dist-renderer/index.html',
    url: 'file:///app/dist-renderer/index.html',
    useDevServer: false,
  });

  assert.equal(clearCount, 1);
});
