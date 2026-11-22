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
import { selectPrunableCapsules } from './compat-capsule.mjs';

test('rolling capsule pruning never deletes first-nightly or milestone baselines', () => {
  const assets = [
    { name: 'capsule-first-nightly.tar.gz', created_at: '2026-11-22T00:00:00Z' },
    { name: 'capsule-milestone-0.3.0.tar.gz', created_at: '2026-12-01T00:00:00Z' },
    { name: 'capsule-nightly-0.2.0-nightly.20261122.1.tar.gz', created_at: '2026-11-22T01:00:00Z' },
    { name: 'capsule-nightly-0.2.0-nightly.20261123.1.tar.gz', created_at: '2026-11-23T01:00:00Z' },
    { name: 'capsule-nightly-0.2.0-nightly.20261124.1.tar.gz', created_at: '2026-11-24T01:00:00Z' },
    { name: 'capsule-nightly-0.2.0-nightly.20261125.1.tar.gz', created_at: '2026-11-25T01:00:00Z' },
    { name: 'capsule-nightly-0.2.0-nightly.20261126.1.tar.gz', created_at: '2026-11-26T01:00:00Z' },
  ];
  const pruned = selectPrunableCapsules(assets, 3);
  assert.deepEqual(pruned, [
    'capsule-nightly-0.2.0-nightly.20261123.1.tar.gz',
    'capsule-nightly-0.2.0-nightly.20261122.1.tar.gz',
  ]);
});
