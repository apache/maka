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
import {
  createDigestAccumulator,
  finishDigest,
  normalizeCodexThreadRow,
  renderForeignSessionDigestForPrompt,
} from '../foreign-session.js';

describe('foreign session timestamp bounds', () => {
  it('rejects timestamps outside the ECMAScript TimeClip range', () => {
    assert.equal(
      normalizeCodexThreadRow({ id: 'future', rollout_path: '/p', updated_at_ms: 1e16 })
        ?.updatedAtMs,
      0,
    );
    assert.equal(
      normalizeCodexThreadRow({ id: 'past', rollout_path: '/p', updated_at_ms: -1e16 })
        ?.updatedAtMs,
      0,
    );
  });

  it('renders out-of-range finite timestamps as unknown instead of throwing', () => {
    const digest = finishDigest(createDigestAccumulator(), {
      source: 'codex',
      id: 'safeid',
      title: 'Future session',
      cwd: '/repo',
      updatedAtMs: 1e16,
    });

    assert.match(renderForeignSessionDigestForPrompt(digest), /^updated_at=unknown$/m);
  });
});
