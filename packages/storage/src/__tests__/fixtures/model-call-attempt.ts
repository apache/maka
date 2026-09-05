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

import {
  MODEL_CALL_ATTEMPT_SCHEMA_VERSION,
  type ModelCallAttempt,
} from '@maka/core/model-call-attempt';
import type { DatabaseSync } from 'node:sqlite';

export const MODEL_CALL_NOW = 1_750_000_000_000;

export function modelCallAttempt(overrides: Partial<ModelCallAttempt> = {}): ModelCallAttempt {
  return {
    schemaVersion: MODEL_CALL_ATTEMPT_SCHEMA_VERSION,
    logicalCallId: 'call-1',
    attemptId: 'attempt-1',
    traceId: 'trace-1',
    sessionId: 'session-1',
    runId: 'run-1',
    turnId: 'turn-1',
    step: 0,
    attempt: 0,
    callKind: 'main',
    providerId: 'anthropic',
    modelId: 'claude-opus-5',
    startedAt: MODEL_CALL_NOW - 1_000,
    completedAt: MODEL_CALL_NOW - 500,
    latencyMs: 500,
    status: 'completed',
    usageBasis: 'reported',
    inputTokens: 100,
    outputTokens: 20,
    costBasis: 'priced',
    costUsd: 0.004,
    ...overrides,
  };
}

/**
 * An attempt carrying the request evidence the projection drops, sized like the
 * real thing: this is what made a stored row grow with the conversation rather
 * than with spend.
 */
export function wideModelCallAttempt(overrides: Partial<ModelCallAttempt> = {}): ModelCallAttempt {
  return modelCallAttempt({
    promptComposition: { segments: [{ kind: 'messages', bytes: 4_096 }] },
    requestObservation: {
      schemaVersion: 1,
      digest: `sha256:${'a'.repeat(64)}`,
      bytes: 27_817,
      segments: Array.from({ length: 64 }, (_, index) => ({
        kind: 'tool_schema' as const,
        index,
        cacheable: true,
        comparison: 'exact' as const,
        digest: `sha256:${String(index).padStart(64, '0')}`,
        bytes: 434,
        label: `tool-${index}`,
      })),
    },
    providerRequestId: 'req-1',
    httpStatus: 200,
    pricingRevision: 3,
    ...overrides,
  });
}

/** The keys a projection row is allowed to hold, sorted for assertion. */
export const MODEL_CALL_PRICING_ROW_KEYS = [
  'attemptId',
  'callKind',
  'completedAt',
  'costBasis',
  'costUsd',
  'inputTokens',
  'latencyMs',
  'logicalCallId',
  'modelId',
  'outputTokens',
  'providerId',
  'sessionId',
  'status',
  'turnId',
  'usageBasis',
];

/** The projection row exactly as it sits on disk. */
export function storedModelCallRecord(
  database: DatabaseSync,
  attemptId: string,
): Record<string, unknown> {
  const row = database
    .prepare('SELECT record_json FROM usage_model_call_attempts WHERE attempt_id = ?')
    .get(attemptId) as { record_json?: string } | undefined;
  return JSON.parse(row?.record_json ?? '{}') as Record<string, unknown>;
}
