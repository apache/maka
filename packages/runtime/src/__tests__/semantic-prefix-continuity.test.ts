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
import { test } from 'node:test';
import type {
  PreparedRequestObservation,
  PreparedRequestObservationSegment,
} from '@maka/core/model-call-attempt';
import { deriveSemanticPrefixContinuity } from '../semantic-prefix-continuity.js';

test('keeps every earlier cacheable segment when the current request only appends', () => {
  const previous = observation([message(0, 'system'), message(1, 'user-1')]);
  const current = observation([
    message(0, 'system'),
    message(1, 'user-1'),
    message(2, 'assistant-1'),
  ]);

  assert.deepEqual(deriveSemanticPrefixContinuity(current, previous), {
    status: 'preserved',
    previousSegmentCount: 2,
    preservedSegmentCount: 2,
  });
});

test('does not treat opaque digests as evidence of divergence', () => {
  const previous = observation([{ ...message(0, 'redacted-a'), comparison: 'opaque' }]);
  const current = observation([{ ...message(0, 'redacted-b'), comparison: 'opaque' }]);

  assert.deepEqual(deriveSemanticPrefixContinuity(current, previous), {
    status: 'unknown',
    previousSegmentCount: 1,
    preservedSegmentCount: 0,
  });
});

test('reports the first changed earlier segment', () => {
  const previous = observation([message(0, 'system'), message(1, 'user-1')]);
  const current = observation([message(0, 'system'), message(1, 'edited-user-1')]);

  assert.deepEqual(deriveSemanticPrefixContinuity(current, previous), {
    status: 'diverged',
    previousSegmentCount: 2,
    preservedSegmentCount: 1,
    firstDivergentSegment: { kind: 'message', index: 1 },
  });
});

test('reports the first removed earlier segment', () => {
  const previous = observation([message(0, 'system'), message(1, 'user-1')]);
  const current = observation([message(0, 'system')]);

  assert.deepEqual(deriveSemanticPrefixContinuity(current, previous), {
    status: 'diverged',
    previousSegmentCount: 2,
    preservedSegmentCount: 1,
    firstDivergentSegment: { kind: 'message', index: 1 },
  });
});

function observation(segments: PreparedRequestObservationSegment[]): PreparedRequestObservation {
  return { schemaVersion: 1, digest: 'request', bytes: 1, segments };
}

function message(index: number, digest: string): PreparedRequestObservationSegment {
  return {
    kind: 'message',
    index,
    cacheable: true,
    comparison: 'exact',
    digest,
    bytes: 1,
  };
}
