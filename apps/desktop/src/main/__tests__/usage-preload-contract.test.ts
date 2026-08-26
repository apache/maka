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
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const preloadSource = readFileSync(
  fileURLToPath(new URL('../../../src/preload/preload.ts', import.meta.url)),
  'utf8',
);

test('Host usage stats unwrap the reconnectable read Result before reaching the renderer', () => {
  assert.match(
    preloadSource,
    /unwrapRuntimeHostReadResult\(\s*await invokeSelectedRuntimeHost<Result<UsageStats>>\(host, 'usage:stats', range\),?\s*\)/u,
  );
});
