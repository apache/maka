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
import {
  HOST_OPERATION_SPECS,
  REMOTE_OWNER_OPERATION_GRANTS,
  decodeRequestFrame,
  decodeResponseFrame,
} from '../protocol/index.js';

const successResult = {
  ok: true as const,
  facts: [{ content: 'the workspace deploys with make', kind: 'fact', observedAt: 1 }],
  passages: [
    {
      sessionId: 'session-1',
      sessionTitle: 'deploy notes',
      turnId: 'turn-2',
      anchorMessageId: 'message-7',
      sequence: 7,
      messages: [
        {
          messageId: 'message-7',
          role: 'assistant' as const,
          matchKind: 'assistant_message',
          text: 'run the deploy script',
          timestamp: 1_700_000_000_000,
          isAnchor: true,
        },
      ],
      matchedTerms: ['deploy'],
      score: 1.25,
      hasMoreBefore: false,
      hasMoreAfter: true,
    },
  ],
  gaps: 'Searched 1 Session(s).',
  searchedEverySession: true,
};

test('recall.query is a ready read-only query gated to remote owners deliberately', () => {
  const spec = HOST_OPERATION_SPECS['recall.query'];
  assert.equal(spec.mode, 'query');
  assert.equal(spec.availability, 'ready');
  assert.deepEqual(
    decodeRequestFrame({
      requestId: 'request-1',
      operation: 'recall.query',
      input: { terms: ['deploy'] },
    }),
    {
      requestId: 'request-1',
      operation: 'recall.query',
      input: { terms: ['deploy'] },
    },
  );
  // A Client searches its own Host's history. The grant is what lets a remote
  // owner connect and query; without it the operation would be local-only.
  assert.equal(REMOTE_OWNER_OPERATION_GRANTS.includes('recall.query'), true);
});

test('recall.query round-trips a success envelope including the navigation index', () => {
  assert.deepEqual(
    decodeResponseFrame({
      requestId: 'request-1',
      operation: 'recall.query',
      ok: true,
      result: successResult,
    }),
    {
      requestId: 'request-1',
      operation: 'recall.query',
      ok: true,
      result: successResult,
    },
  );
  // The whole point of the field: a Client needs the anchor's transcript index
  // to scroll to the hit, not merely its identity. Comparing the decoded result
  // keeps the assertion on the field rather than on the union's shape.
  assert.deepEqual(HOST_OPERATION_SPECS['recall.query'].decodeOutput(successResult), successResult);
});

test('recall.query carries a material as an address or a location, never both', () => {
  const base = successResult.passages[0]!;
  const withAddress = {
    ...successResult,
    passages: [
      {
        ...base,
        messages: [
          {
            ...base.messages[0]!,
            text: '',
            materials: [
              {
                name: 'diagram.png',
                kind: 'image' as const,
                mimeType: 'image/png',
                bytes: 12,
                resource: 'maka://attachment/session-1/diagram.png',
              },
            ],
          },
        ],
      },
    ],
  };
  assert.doesNotThrow(() =>
    decodeResponseFrame({
      requestId: 'request-1',
      operation: 'recall.query',
      ok: true,
      result: withAddress,
    }),
  );
  // An address means "read this now"; a location means "ask for it". Carrying
  // both would offer two answers to one question, so the frame is refused.
  assert.throws(() =>
    decodeResponseFrame({
      requestId: 'request-1',
      operation: 'recall.query',
      ok: true,
      result: {
        ...withAddress,
        passages: [
          {
            ...base,
            messages: [
              {
                ...withAddress.passages[0]!.messages[0]!,
                materials: [
                  {
                    ...withAddress.passages[0]!.messages[0]!.materials[0]!,
                    sourceSessionId: 'session-2',
                    materialId: 'material-3',
                  },
                ],
              },
            ],
          },
        ],
      },
    }),
  );
});

test('recall.query refuses a malformed input and a negative navigation index', () => {
  assert.throws(() =>
    decodeRequestFrame({ requestId: 'request-1', operation: 'recall.query', input: {} }),
  );
  assert.throws(() =>
    decodeRequestFrame({
      requestId: 'request-1',
      operation: 'recall.query',
      input: { terms: [] },
    }),
  );
  assert.throws(() =>
    decodeRequestFrame({
      requestId: 'request-1',
      operation: 'recall.query',
      input: { terms: ['deploy'], limit: 0 },
    }),
  );
  assert.throws(() =>
    decodeResponseFrame({
      requestId: 'request-1',
      operation: 'recall.query',
      ok: true,
      result: {
        ...successResult,
        passages: [{ ...successResult.passages[0]!, sequence: -1 }],
      },
    }),
  );
});

test('recall.query reports its own failure vocabulary over the wire', () => {
  assert.deepEqual(
    HOST_OPERATION_SPECS['recall.query'].decodeOutput({
      ok: false,
      reason: 'incognito_active',
      message: 'Recall is unavailable.',
    }),
    { ok: false, reason: 'incognito_active', message: 'Recall is unavailable.' },
  );
  assert.throws(() =>
    HOST_OPERATION_SPECS['recall.query'].decodeOutput({
      ok: false,
      reason: 'malformed',
      message: 'nope',
    }),
  );
});
