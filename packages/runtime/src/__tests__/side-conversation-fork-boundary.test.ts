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
import type { RuntimeEvent } from '@maka/core/runtime-event';
import type { SessionHeader } from '@maka/core/session';
import { resolveSideConversationForkBoundaryEventId } from '../side-conversation-fork-boundary.js';

const SIDE_LABELS: SessionHeader['labels'] = ['mode:side_conversation'];

function textEvent(id: string, turnId: string, text: string): RuntimeEvent {
  return {
    id,
    sessionId: 'session-1',
    runId: `run-${turnId}`,
    invocationId: `invocation-${turnId}`,
    turnId,
    ts: 1,
    partial: false,
    role: 'user',
    author: 'user',
    content: { kind: 'text', text },
  };
}

function sideHeader(input: {
  kind?: 'branch' | 'revision';
  sourceTurnId?: string;
  branchOfTurnId?: string;
}): Pick<SessionHeader, 'labels' | 'conversationCopy' | 'branchOfTurnId'> {
  return {
    labels: SIDE_LABELS,
    conversationCopy: {
      kind: input.kind ?? 'branch',
      sourceSessionId: 'session-parent',
      ...(input.sourceTurnId === undefined ? {} : { sourceTurnId: input.sourceTurnId }),
      requestFingerprint: `sha256:${'a'.repeat(64)}`,
      state: 'committed',
    },
    ...(input.branchOfTurnId === undefined ? {} : { branchOfTurnId: input.branchOfTurnId }),
  };
}

test('non-side sessions resolve no boundary', () => {
  const events = [textEvent('ev-parent', 'turn-parent', 'parent question')];
  const header: Pick<SessionHeader, 'labels' | 'conversationCopy'> = {
    labels: [],
    conversationCopy: undefined,
  };
  assert.equal(resolveSideConversationForkBoundaryEventId(events, header), undefined);
});

test('fresh side fork on the first send resolves no boundary (caller prefixes the new turn)', () => {
  const events = [
    textEvent('ev-p1', 'turn-p1', 'parent one'),
    textEvent('ev-p2', 'turn-p2', 'parent two'),
  ];
  const header = sideHeader({ sourceTurnId: 'turn-p2', branchOfTurnId: 'turn-p2' });
  assert.equal(resolveSideConversationForkBoundaryEventId(events, header), undefined);
});

test('fresh side fork on a follow-up keeps the boundary on the fork first user turn', () => {
  const events = [
    textEvent('ev-p1', 'turn-p1', 'parent one'),
    textEvent('ev-p2', 'turn-p2', 'parent two'),
    textEvent('ev-s1', 'turn-s1', 'side one'),
  ];
  const header = sideHeader({ sourceTurnId: 'turn-p2', branchOfTurnId: 'turn-p2' });
  assert.equal(resolveSideConversationForkBoundaryEventId(events, header), 'ev-s1');
});

test('revision of a side fork with TWO copied parent turns keeps the boundary on the fork first user turn', () => {
  // The user revises side turn S2. The revision copies every turn BEFORE S2 —
  // turns P1 and P2 of the inherited parent prefix AND the fork's own first
  // turn S1 — and slices S2 itself out, so conversationCopy.sourceTurnId (S2)
  // is absent from the replay. The boundary must stay on S1 (the fork's first
  // own user message, whose cached provider prefix the revision inherits), not
  // on P2's user event inside the inherited parent prefix.
  const events = [
    textEvent('ev-p1', 'turn-p1', 'parent one'),
    textEvent('ev-p2', 'turn-p2', 'parent two'),
    textEvent('ev-s1', 'turn-s1', 'side one'),
    textEvent('ev-s2', 'turn-s2-revised', 'side two revised'),
  ];
  const header = sideHeader({
    kind: 'revision',
    sourceTurnId: 'turn-s2',
    branchOfTurnId: 'turn-p2',
  });
  assert.equal(resolveSideConversationForkBoundaryEventId(events, header), 'ev-s1');
});

test('revision follow-up keeps the boundary on the fork first user turn', () => {
  const events = [
    textEvent('ev-p1', 'turn-p1', 'parent one'),
    textEvent('ev-p2', 'turn-p2', 'parent two'),
    textEvent('ev-s1', 'turn-s1', 'side one'),
    textEvent('ev-s2', 'turn-s2-revised', 'side two revised'),
    textEvent('ev-s3', 'turn-s3', 'side three'),
  ];
  const header = sideHeader({
    kind: 'revision',
    sourceTurnId: 'turn-s2',
    branchOfTurnId: 'turn-p2',
  });
  assert.equal(resolveSideConversationForkBoundaryEventId(events, header), 'ev-s1');
});

test('revision OF a revision inherits the original fork boundary turn', () => {
  const events = [
    textEvent('ev-p1', 'turn-p1', 'parent one'),
    textEvent('ev-p2', 'turn-p2', 'parent two'),
    textEvent('ev-s1', 'turn-s1', 'side one'),
    textEvent('ev-s2', 'turn-s2-revised', 'side two revised'),
    textEvent('ev-s3', 'turn-s3-revised-again', 'side two re-revised'),
  ];
  const header = sideHeader({
    kind: 'revision',
    sourceTurnId: 'turn-s3',
    branchOfTurnId: 'turn-p2',
  });
  assert.equal(resolveSideConversationForkBoundaryEventId(events, header), 'ev-s1');
});

test('revision slicing out the fork boundary turn resolves no boundary (only parent history replays)', () => {
  const events = [textEvent('ev-p1', 'turn-p1', 'parent one')];
  const header = sideHeader({
    kind: 'revision',
    sourceTurnId: 'turn-p2',
    branchOfTurnId: 'turn-p2',
  });
  assert.equal(resolveSideConversationForkBoundaryEventId(events, header), undefined);
});

test('empty side fork resolves the first replayed user turn as the boundary', () => {
  const events = [textEvent('ev-s1', 'turn-s1', 'side one')];
  const header = sideHeader({});
  assert.equal(resolveSideConversationForkBoundaryEventId(events, header), 'ev-s1');
});

test('revision copy of an EMPTY side fork keeps the boundary on the fork first user turn', () => {
  // An empty side fork has no fork boundary turn and no parent prefix, so its
  // revisions copy pure side-conversation history: every replayed turn is
  // fork-owned and the first user text event owns the boundary. The revised
  // turn is the current turn and never appears in the resolved events.
  const events = [textEvent('ev-s1', 'turn-s1', 'side one')];
  const header = sideHeader({ kind: 'revision', sourceTurnId: 'turn-s2' });
  assert.equal(resolveSideConversationForkBoundaryEventId(events, header), 'ev-s1');
});
