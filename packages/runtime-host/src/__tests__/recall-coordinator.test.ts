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
import type { RecallDeps } from '@maka/core/recall';
import type { SessionSummary, StoredMessage } from '@maka/core/session';
import { HostRecallCoordinator, projectRecallResult } from '../server/recall-coordinator.js';

function session(id: string, name: string, lastMessageAt = 1): SessionSummary {
  return {
    id,
    name,
    isFlagged: false,
    isArchived: false,
    backend: 'runtime-host',
    lastMessageAt,
  } as unknown as SessionSummary;
}

function user(id: string, turnId: string, text: string, ts = 1): StoredMessage {
  return { type: 'user', id, turnId, ts, text } as StoredMessage;
}

function deps(messages: readonly StoredMessage[], overrides: Partial<RecallDeps> = {}): RecallDeps {
  return {
    listSessions: async () => [session('s1', 'deploy notes')],
    readMessages: async () => [...messages],
    getPrivacyContext: async () => ({ incognitoActive: false }),
    ...overrides,
  };
}

test('serves a recall query end to end over the Host deps', async () => {
  const coordinator = new HostRecallCoordinator(
    deps([user('m1', 't1', 'unrelated opening'), user('m2', 't1', 'run the deploy script now')]),
  );
  const outcome = await coordinator.handlers['recall.query'](
    { terms: ['deploy'] },
    undefined as never,
  );
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.result.ok, true);
  if (!outcome.result.ok) return;
  assert.equal(outcome.result.passages.length, 1);
  const passage = outcome.result.passages[0]!;
  assert.equal(passage.sessionId, 's1');
  assert.equal(passage.sessionTitle, 'deploy notes');
  assert.equal(passage.anchorMessageId, 'm2');
  // The coordinate a Client scrolls to. `m2` is the second message, so an
  // off-by-one or a reused ranking score here would send a click to the wrong row.
  assert.equal(passage.sequence, 1);
});

test('a Client search is not inside a turn, so nothing is excluded from it', async () => {
  // The model's tool must not surface its own turn back as corroboration. A
  // Client search has no turn, so the same message stays reachable — this
  // pins that the coordinator does not accidentally inherit the tool's rule.
  const coordinator = new HostRecallCoordinator(
    deps([user('m1', 't1', 'run the deploy script now')]),
  );
  const outcome = await coordinator.handlers['recall.query'](
    { terms: ['deploy'] },
    undefined as never,
  );
  assert.equal(outcome.ok, true);
  if (!outcome.ok || !outcome.result.ok) return assert.fail('expected a passage');
  assert.equal(outcome.result.passages.length, 1);
});

test('a failure reason crosses as a result, not as a Host error', async () => {
  // Privacy refusal is a fact about the corpus, not a fault in this operation;
  // answering it as `internal_failure` would tell a Client to retry.
  const coordinator = new HostRecallCoordinator(
    deps([user('m1', 't1', 'anything')], {
      getPrivacyContext: async () => ({ incognitoActive: true }),
    }),
  );
  const outcome = await coordinator.handlers['recall.query'](
    { terms: ['deploy'] },
    undefined as never,
  );
  assert.equal(outcome.ok, true);
  if (!outcome.ok || outcome.result.ok) return assert.fail('expected a refusal envelope');
  assert.equal(outcome.result.reason, 'incognito_active');
  assert.ok(outcome.result.message.length > 0, 'the refusal must explain itself');
});

test('a malformed request is refused without touching the corpus', async () => {
  let read = 0;
  const coordinator = new HostRecallCoordinator(
    deps([], {
      listSessions: async () => {
        read += 1;
        return [];
      },
    }),
  );
  const outcome = await coordinator.handlers['recall.query'](
    { terms: [] } as never,
    undefined as never,
  );
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return assert.fail('a refused query is not a Host failure');
  assert.equal(outcome.result.ok, false);
  if (outcome.result.ok) return;
  assert.equal(outcome.result.reason, 'invalid_query');
  assert.equal(read, 0, 'a rejected query must not read the corpus');
});

test('projects the core envelope into the wire shape, keeping the navigation index', () => {
  const projected = projectRecallResult({
    ok: true,
    facts: [{ content: 'a fact', kind: 'fact', observedAt: 1 }],
    passages: [
      {
        sessionId: 's1',
        sessionTitle: 'title',
        turnId: 't1',
        anchorMessageId: 'm2',
        sequence: 3,
        messages: [
          {
            messageId: 'm2',
            role: 'assistant',
            matchKind: 'assistant_message',
            text: 'text',
            timestamp: 1,
            isAnchor: true,
            materials: [
              { name: 'a.png', kind: 'image', mimeType: 'image/png', bytes: 3, resource: 'ref' },
              {
                name: 'b.pdf',
                kind: 'pdf',
                mimeType: 'application/pdf',
                bytes: 4,
                sourceSessionId: 's0',
                materialId: 'mat-1',
              },
            ],
          },
        ],
        matchedTerms: ['text'],
        score: 2.5,
        hasMoreBefore: true,
        hasMoreAfter: false,
      },
    ],
    gaps: 'Searched 1 Session(s).',
    scannedFully: false,
  });
  assert.equal(projected.ok, true);
  if (!projected.ok) return;
  assert.equal(projected.searchedEverySession, false);
  const passage = projected.passages[0]!;
  assert.equal(passage.sequence, 3);
  assert.deepEqual(passage.messages[0]!.materials, [
    { name: 'a.png', kind: 'image', mimeType: 'image/png', bytes: 3, resource: 'ref' },
    {
      name: 'b.pdf',
      kind: 'pdf',
      mimeType: 'application/pdf',
      bytes: 4,
      sourceSessionId: 's0',
      materialId: 'mat-1',
    },
  ]);
});

test('projects a failure without inventing a success envelope', () => {
  assert.deepEqual(projectRecallResult({ ok: false, reason: 'not_found', message: 'nope' }), {
    ok: false,
    reason: 'not_found',
    message: 'nope',
  });
});
