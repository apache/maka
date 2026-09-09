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
import { projectTranscriptRows } from '../transcript-row-projection.js';

interface TurnStub {
  turnId: string;
}

const turns: readonly TurnStub[] = [
  { turnId: 'turn-2' },
  { turnId: 'turn-3' },
  { turnId: 'turn-4' },
];

function rowKeys(input: ReturnType<typeof projectTranscriptRows<TurnStub>>): string[] {
  return input.map((row) => row.kind === 'turn' ? row.turn.turnId : `gap:${row.direction}`);
}

describe('transcript boundary row projection', () => {
  test('preserves the resident Turn order when both boundaries are complete', () => {
    const rows = projectTranscriptRows({ turns, hasOlder: false, hasNewer: false });

    assert.deepEqual(rowKeys(rows), ['turn-2', 'turn-3', 'turn-4']);
    assert.strictEqual(rows[0]?.kind === 'turn' ? rows[0].turn : undefined, turns[0]);
  });

  test('places one older gap before the resident window', () => {
    const rows = projectTranscriptRows({ turns, hasOlder: true, hasNewer: false });

    assert.deepEqual(rowKeys(rows), ['gap:older', 'turn-2', 'turn-3', 'turn-4']);
  });

  test('places one newer gap after a resident window without an active Turn', () => {
    const rows = projectTranscriptRows({ turns, hasOlder: false, hasNewer: true });

    assert.deepEqual(rowKeys(rows), ['turn-2', 'turn-3', 'turn-4', 'gap:newer']);
  });

  test('places the newer gap immediately before the separately rendered active Turn', () => {
    const rows = projectTranscriptRows({
      turns,
      hasOlder: true,
      hasNewer: true,
      activeTurnId: 'turn-4',
    });

    assert.deepEqual(rowKeys(rows), [
      'gap:older',
      'turn-2',
      'turn-3',
      'gap:newer',
      'turn-4',
    ]);
  });

  test('keeps a newer gap at the trailing boundary when the active Turn is not resident', () => {
    const rows = projectTranscriptRows({
      turns,
      hasOlder: false,
      hasNewer: true,
      activeTurnId: 'turn-live',
    });

    assert.deepEqual(rowKeys(rows), ['turn-2', 'turn-3', 'turn-4', 'gap:newer']);
  });

  test('projects only the two truthful boundaries for an empty resident window', () => {
    const rows = projectTranscriptRows<TurnStub>({
      turns: [],
      hasOlder: true,
      hasNewer: true,
    });

    assert.deepEqual(rowKeys(rows), ['gap:older', 'gap:newer']);
  });
});
