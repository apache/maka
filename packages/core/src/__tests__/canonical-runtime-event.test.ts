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
import { encodeCanonicalRuntimeEvent } from '../canonical-runtime-event.js';
import type { RuntimeEvent } from '../runtime-event.js';

function baseEvent(overrides: Partial<RuntimeEvent> = {}): RuntimeEvent {
  return {
    id: 'evt-1',
    invocationId: 'inv-1',
    runId: 'run-1',
    sessionId: 'sess-1',
    turnId: 'turn-1',
    ts: 100,
    partial: false,
    role: 'system',
    author: 'system',
    ...overrides,
  };
}

describe('canonical RuntimeEvent encoding', () => {
  test('omits undefined optional fields from token-usage diagnostics', () => {
    const event = baseEvent({
      actions: {
        tokenUsage: {
          input: 226_495,
          output: 1_080,
          promptSegments: [
            {
              kind: 'prior_history',
              chars: 65_680,
              estimatedTokens: 16_420,
              messageCount: 8,
              eventCount: 11,
              toolCount: undefined,
            },
          ],
          contextBudget: {
            enabled: true,
            estimatedTokensBefore: 261_636,
            estimatedTokensAfter: 221,
            keptTurns: 1,
            droppedTurns: 7,
            keptEvents: 3,
            droppedEvents: 42,
            policyName: undefined,
            compactionDecisions: [
              {
                stage: 'priorReplay',
                sourceKind: 'runtimeEvents',
                decision: 'replaced',
                phase: 'mid_turn',
                boundaryKind: 'historyCompact',
                boundaryIds: ['compact-1'],
                coverageHashes: ['sha256:compact-1'],
                estimatedTokensBefore: 261_636,
                estimatedTokensAfter: 221,
                estimatedTokensSaved: 261_415,
                reason: undefined,
              },
            ],
          },
        },
      },
    });

    const encoded = encodeCanonicalRuntimeEvent(event);

    const tokenUsage = encoded.event.actions?.tokenUsage;
    assert.ok(tokenUsage);
    assert.equal(Object.hasOwn(tokenUsage.promptSegments?.[0] ?? {}, 'toolCount'), false);
    assert.equal(Object.hasOwn(tokenUsage.contextBudget ?? {}, 'policyName'), false);
    assert.equal(
      Object.hasOwn(tokenUsage.contextBudget?.compactionDecisions?.[0] ?? {}, 'reason'),
      false,
    );
  });

  test('still rejects undefined nested in arbitrary JSON payloads', () => {
    const event = baseEvent({
      role: 'tool',
      author: 'tool',
      content: {
        kind: 'function_response',
        id: 'call-1',
        name: 'example',
        result: { value: undefined },
      },
    });

    assert.throws(
      () => encodeCanonicalRuntimeEvent(event),
      /RuntimeEvent is not losslessly serializable/,
    );
  });
});
