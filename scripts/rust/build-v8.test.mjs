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
import { prepareV8SourceDir } from './build-v8.mjs';

test('prepareV8SourceDir keeps caller directory on non-Windows', async () => {
  const result = await prepareV8SourceDir('/tmp/maka-nightly-build-abc/v8', {
    platform: 'linux',
    mkdtempFn: () => assert.fail('must not allocate drive-root dir on non-Windows'),
  });
  assert.equal(result.directory, '/tmp/maka-nightly-build-abc/v8');
  await result.cleanup();
});

test('prepareV8SourceDir allocates and cleans up a drive-root temp dir on Windows', async () => {
  let createdPrefix = null;
  let removed = null;
  const result = await prepareV8SourceDir('/tmp/maka-nightly-build-abc/v8', {
    platform: 'win32',
    mkdtempFn: async (prefix) => {
      createdPrefix = prefix;
      return prefix + 'xyz';
    },
    rmFn: async (dir) => {
      removed = dir;
    },
  });
  assert.ok(createdPrefix.endsWith('v8-'), 'unexpected prefix: ' + createdPrefix);
  assert.equal(result.directory, createdPrefix + 'xyz');
  await result.cleanup();
  assert.equal(removed, createdPrefix + 'xyz');
});

test('prepareV8SourceDir falls back to caller directory when drive root is not writable', async () => {
  const result = await prepareV8SourceDir('/tmp/maka-nightly-build-abc/v8', {
    platform: 'win32',
    mkdtempFn: async () => {
      const err = new Error('permission denied');
      err.code = 'EPERM';
      throw err;
    },
  });
  assert.equal(result.directory, '/tmp/maka-nightly-build-abc/v8');
  await result.cleanup();
});
