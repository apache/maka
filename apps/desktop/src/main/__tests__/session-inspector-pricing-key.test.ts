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
  SESSION_TRACE_SCHEMA_VERSION,
  type SessionTrace,
  type TraceModelAttempt,
} from '@maka/core/session-trace';
import { deriveInspectorPanelModel } from '../../renderer/session-inspector-panel-model.js';

describe('Session Inspector Pricing key', () => {
  test('uses the canonical provider rather than the connection slug for an unpriced call', () => {
    const model = deriveInspectorPanelModel(traceWithAttempt(attempt('unpriced')));

    assert.equal(model.turns[0]?.steps[0]?.unpricedPricingKey, 'DeepInfra:org/Model:Preview');
  });

  test('does not offer a Pricing key when the call was priced', () => {
    const model = deriveInspectorPanelModel(traceWithAttempt(attempt('priced')));

    assert.equal(model.turns[0]?.steps[0]?.unpricedPricingKey, undefined);
  });
});

function attempt(costBasis: TraceModelAttempt['costBasis']): TraceModelAttempt {
  return {
    attemptId: 'attempt-1',
    attempt: 0,
    status: 'completed',
    startedAt: 1,
    completedAt: 11,
    latencyMs: 10,
    ...(costBasis === 'priced' ? { costUsd: 0.01 } : {}),
    costBasis,
    usageBasis: 'reported',
  };
}

function traceWithAttempt(modelAttempt: TraceModelAttempt): SessionTrace {
  return {
    schemaVersion: SESSION_TRACE_SCHEMA_VERSION,
    sessionId: 'session-1',
    turns: [
      {
        turnId: 'turn-1',
        runId: 'run-1',
        startedAt: 1,
        endedAt: 11,
        durationMs: 10,
        steps: [
          {
            kind: 'model_call',
            id: 'call-1',
            turnId: 'turn-1',
            runId: 'run-1',
            startedAt: 1,
            endedAt: 11,
            durationMs: 10,
            callKind: 'main',
            connectionSlug: 'my-deepinfra-account',
            providerId: 'DeepInfra',
            modelId: 'org/Model:Preview',
            step: 0,
            attempts: [modelAttempt],
            status: 'completed',
            ...(modelAttempt.costBasis === 'priced' ? { costUsd: 0.01 } : {}),
          },
        ],
      },
    ],
    coverage: {
      modelCalls: 'no_known_gap',
      turnsMissingModelCalls: [],
      unreadableRecords: 0,
      oversizedRuns: 0,
      turnsWithFewerModelCallsThanSteps: [],
    },
  };
}
