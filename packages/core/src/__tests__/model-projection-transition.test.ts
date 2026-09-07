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

import type { DurableToolResultProjection } from '../durable-tool-result-projection.js';
import {
  buildModelProjectionTransition,
  decodeModelProjectionTransition,
  durableToolResultProjectionDigest,
  isModelProjectionTransition,
} from '../model-projection-transition.js';

const SOURCE: DurableToolResultProjection = {
  version: 1,
  kind: 'text',
  text: 'a large tool result',
};

const REPLACEMENT: DurableToolResultProjection = {
  version: 1,
  kind: 'json',
  value: { kind: 'maka.archived_tool_result', artifactId: 'artifact-1' },
};

function build(overrides: Partial<Parameters<typeof buildModelProjectionTransition>[0]> = {}) {
  return buildModelProjectionTransition({
    sessionId: 'session-1',
    target: {
      runtimeEventId: 'rt-result',
      part: 'tool_result',
      toolCallId: 'tool-1',
      toolName: 'Read',
    },
    sourceProjection: SOURCE,
    replacement: REPLACEMENT,
    now: 1_700_000_000,
    ...overrides,
  });
}

describe('model projection transition schema', () => {
  test('digests the same projection identically regardless of key order', () => {
    const reordered = {
      kind: 'text',
      text: SOURCE.text,
      version: 1,
    } as DurableToolResultProjection;
    assert.equal(
      durableToolResultProjectionDigest(reordered),
      durableToolResultProjectionDigest(SOURCE),
    );
  });

  test('binds the record to the projection it may replace', () => {
    const transition = build();
    assert.equal(transition.sourceProjectionDigest, durableToolResultProjectionDigest(SOURCE));
    assert.equal(transition.createdAt, 1_700_000_000);
  });

  test('derives one id from content, so a duplicated concurrent append is idempotent', () => {
    assert.equal(build().transitionId, build().transitionId);
    // The clock is not part of the decision, so it must not be part of the id.
    assert.equal(build().transitionId, build({ now: 1_800_000_000 }).transitionId);
    assert.notEqual(
      build().transitionId,
      build({ previousTransitionId: 'mptransition-earlier' }).transitionId,
    );
  });

  test('rejects a record that belongs to another Session', () => {
    const transition = build();
    assert.ok(isModelProjectionTransition(transition, 'session-1'));
    assert.equal(isModelProjectionTransition(transition, 'session-2'), false);
    assert.throws(() => decodeModelProjectionTransition(transition, 'session-2'));
  });

  test('rejects an unknown field and an unrepresentable replacement', () => {
    const transition = build();
    assert.throws(() =>
      decodeModelProjectionTransition({ ...transition, extra: true }, 'session-1'),
    );
    assert.throws(() =>
      decodeModelProjectionTransition(
        { ...transition, replacement: { version: 1, kind: 'text' } },
        'session-1',
      ),
    );
  });
});
