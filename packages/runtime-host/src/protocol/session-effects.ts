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

import { requireEntityId, requireExactRecord, requireRecord, requireUtf8String } from './codec.js';
import { invalidProtocolFrame } from './errors.js';
import { defineOperation } from './operation-spec.js';

export const SESSION_RECAP_RAW_MAX_BYTES = 16 * 1024;
export const SESSION_RECAP_TEXT_MAX_BYTES = 4 * 1024;

export type SessionRecapReason = 'manual' | 'idle';
export type SessionRecapFailureClass =
  | 'aborted'
  | 'timeout'
  | 'configuration'
  | 'provider'
  | 'invalid_response'
  | 'empty_response'
  | 'unknown';

export interface SessionRecapGenerateInput {
  readonly sessionId: string;
  /** Stable logical identity reused when a Client retries the same model effect. */
  readonly effectId: string;
  readonly reason: SessionRecapReason;
}

export type SessionRecapGenerateResult =
  | {
      readonly kind: 'generated';
      readonly effectId: string;
      readonly reason: SessionRecapReason;
      readonly text: string;
      readonly raw: string;
    }
  | {
      readonly kind: 'failed';
      readonly effectId: string;
      readonly reason: SessionRecapReason;
      readonly errorClass: SessionRecapFailureClass;
    };

const SESSION_EFFECT_ERRORS = [
  'host_not_ready',
  'host_draining',
  'operation_unavailable',
  'not_found',
  'session_archived',
  'operation_conflict',
  'persistence_failed',
  'outcome_unknown',
  'internal_failure',
] as const;

export const SESSION_EFFECT_OPERATION_SPECS = {
  'session.recap.generate': defineOperation({
    mode: 'command',
    availability: 'ready',
    errors: SESSION_EFFECT_ERRORS,
    decodeInput: decodeSessionRecapGenerateInput,
    decodeOutput: decodeSessionRecapGenerateResult,
    assertOutputForInput: (input, output) => {
      if (input.effectId !== output.effectId || input.reason !== output.reason) {
        throw invalidProtocolFrame('Session recap changed effect identity');
      }
    },
  }),
} as const;

export function decodeSessionRecapGenerateInput(value: unknown): SessionRecapGenerateInput {
  const input = requireExactRecord(value, 'Session recap input', [
    'sessionId',
    'effectId',
    'reason',
  ]);
  return {
    sessionId: requireEntityId(input.sessionId, 'sessionId'),
    effectId: requireEntityId(input.effectId, 'effectId'),
    reason: decodeSessionRecapReason(input.reason),
  };
}

export function decodeSessionRecapGenerateResult(value: unknown): SessionRecapGenerateResult {
  const result = requireRecord(value, 'Session recap result');
  if (result.kind === 'generated') {
    const generated = requireExactRecord(result, 'Generated Session recap result', [
      'kind',
      'effectId',
      'reason',
      'text',
      'raw',
    ]);
    return {
      kind: 'generated',
      effectId: requireEntityId(generated.effectId, 'effectId'),
      reason: decodeSessionRecapReason(generated.reason),
      text: requireUtf8String(generated.text, 'Session recap text', SESSION_RECAP_TEXT_MAX_BYTES),
      raw: requireUtf8String(generated.raw, 'raw Session recap', SESSION_RECAP_RAW_MAX_BYTES),
    };
  }
  const failed = requireExactRecord(result, 'Failed Session recap result', [
    'kind',
    'effectId',
    'reason',
    'errorClass',
  ]);
  if (failed.kind !== 'failed') throw invalidProtocolFrame('Invalid Session recap result kind');
  return {
    kind: 'failed',
    effectId: requireEntityId(failed.effectId, 'effectId'),
    reason: decodeSessionRecapReason(failed.reason),
    errorClass: decodeSessionRecapFailureClass(failed.errorClass),
  };
}

function decodeSessionRecapReason(value: unknown): SessionRecapReason {
  if (value !== 'manual' && value !== 'idle') {
    throw invalidProtocolFrame('Invalid Session recap reason');
  }
  return value;
}

function decodeSessionRecapFailureClass(value: unknown): SessionRecapFailureClass {
  if (
    value !== 'aborted' &&
    value !== 'timeout' &&
    value !== 'configuration' &&
    value !== 'provider' &&
    value !== 'invalid_response' &&
    value !== 'empty_response' &&
    value !== 'unknown'
  ) {
    throw invalidProtocolFrame('Invalid Session recap failure class');
  }
  return value;
}
