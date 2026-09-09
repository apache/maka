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

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { createGenesisExecutionBoundary } from '../sandbox-boundary.js';

describe('deep research session profile', () => {
  it('gives explore sessions a managed read-only filesystem and restricted network', () => {
    const boundary = createGenesisExecutionBoundary('explore');
    assert.equal(boundary.kind, 'managed');
    if (boundary.kind !== 'managed') return;
    assert.equal(boundary.profile.name, 'read-only');
    assert.deepEqual(boundary.profile.fileSystem, {
      kind: 'restricted',
      entries: [{ kind: 'special', access: 'read', special: ':workspace_roots' }],
    });
    assert.equal(boundary.profile.network.kind, 'restricted');
  });
});
