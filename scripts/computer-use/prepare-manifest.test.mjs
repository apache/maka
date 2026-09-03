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
import { buildMakaCuManifestEntry } from './prepare-manifest.mjs';

test('the maka-cu manifest pins protocol v3 and official source provenance', () => {
  assert.deepEqual(
    buildMakaCuManifestEntry({
      commit: 'a'.repeat(40),
      tree: 'c'.repeat(40),
      binarySizeBytes: 123,
      binarySha256: 'b'.repeat(64),
      signing: { signature: 'adhoc', hardenedRuntime: false },
      stapled: false,
    }),
    {
      repo: 'maka-agent/maka-cu',
      branch: 'maka/base',
      commit: 'a'.repeat(40),
      tree: 'c'.repeat(40),
      expectedProtocolVersion: 'maka.cu/3',
      binaryName: 'maka-cu',
      binarySizeBytes: 123,
      binarySha256: 'b'.repeat(64),
      buildProvenance: 'isolated-official-source-build',
      signature: 'adhoc',
      hardenedRuntime: false,
      notarization: 'missing',
      distributionReady: false,
    },
  );
});
