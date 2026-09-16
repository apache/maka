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
import {
  selectTailTransientMessages,
  turnRendersUserMessage,
  type TurnUserRowSource,
} from '../transient-placement.js';

function turn(overrides: Partial<TurnUserRowSource> = {}): TurnUserRowSource {
  return { timeline: [], ...overrides };
}

function timelineUserItem(messageId: string): TurnUserRowSource['timeline'][number] {
  return { kind: 'user', messageId };
}

function timelineAssistantItem(messageId: string): TurnUserRowSource['timeline'][number] {
  return { kind: 'text', messageId };
}

describe('turnRendersUserMessage', () => {
  test('matches the Turn primary prompt id', () => {
    const turns = [turn({ user: { id: 'msg-1' } })];
    assert.equal(turnRendersUserMessage(turns, 'msg-1'), true);
    assert.equal(turnRendersUserMessage(turns, 'msg-2'), false);
  });

  test('matches an admitted user timeline item id', () => {
    const turns = [turn({ timeline: [timelineUserItem('msg-1')] })];
    assert.equal(turnRendersUserMessage(turns, 'msg-1'), true);
  });

  test('does not match a non-user timeline item that reuses the id', () => {
    const turns = [turn({ timeline: [timelineAssistantItem('msg-1')] })];
    assert.equal(turnRendersUserMessage(turns, 'msg-1'), false);
  });

  test('matches across every rendered Turn, not only the tail', () => {
    const turns = [
      turn({ user: { id: 'older-prompt' } }),
      turn({ user: { id: 'newer-prompt' } }),
    ];
    assert.equal(turnRendersUserMessage(turns, 'older-prompt'), true);
  });

  test('without Turns nothing is already rendered', () => {
    assert.equal(turnRendersUserMessage([], 'msg-1'), false);
    assert.equal(turnRendersUserMessage([turn()], 'msg-1'), false);
  });
});

describe('selectTailTransientMessages', () => {
  const turnsWithPrompt = [
    turn({ user: { id: 'msg-1' }, timeline: [timelineUserItem('msg-1')] }),
  ];

  test('drops a duplicate the tail Turn already renders as its prompt', () => {
    const transients = [{ id: 'msg-1' }];
    assert.deepEqual(
      selectTailTransientMessages(transients, new Set(), turnsWithPrompt),
      [],
    );
  });

  test('keeps a distinct admitted message queued behind the live prompt', () => {
    const transients = [{ id: 'msg-1' }, { id: 'msg-2' }];
    assert.deepEqual(
      selectTailTransientMessages(transients, new Set(), turnsWithPrompt),
      [{ id: 'msg-2' }],
    );
  });

  test('keeps every transient while the Turn has no user row yet', () => {
    const transients = [{ id: 'msg-1' }, { id: 'msg-2' }];
    const pendingTurns = [turn({ user: undefined, timeline: [] })];
    assert.deepEqual(
      selectTailTransientMessages(transients, new Set(), pendingTurns),
      transients,
    );
  });

  test('excludes messages already routed into the inline slot', () => {
    const transients = [{ id: 'msg-1' }, { id: 'msg-2' }];
    assert.deepEqual(
      selectTailTransientMessages(transients, new Set(['msg-2']), []),
      [{ id: 'msg-1' }],
    );
  });
});
