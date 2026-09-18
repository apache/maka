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

import { defineObjectShape, hasExactShape, isRecord } from './record-schema.js';

export type ModelFailureKind =
  | 'abort'
  | 'auth'
  | 'context_overflow'
  | 'network'
  | 'provider_capacity'
  | 'provider_billing'
  | 'provider_unavailable'
  | 'rate_limit'
  | 'request_rejected'
  | 'stream_truncated'
  | 'timeout'
  | 'unknown';
export const MODEL_FAILURE_MESSAGE_MAX_BYTES = 2 * 1024;

export type ModelRetryDecision =
  | { decision: 'exhausted'; attempts: number }
  | { decision: 'declined'; because: 'side_effects' | 'observable_output' | 'policy' | 'budget' };

const EXHAUSTED_SHAPE = defineObjectShape<Extract<ModelRetryDecision, { decision: 'exhausted' }>>()(
  ['decision', 'attempts'],
  [],
);
const DECLINED_SHAPE = defineObjectShape<Extract<ModelRetryDecision, { decision: 'declined' }>>()(
  ['decision', 'because'],
  [],
);

export function isModelRetryDecision(value: unknown): value is ModelRetryDecision {
  if (!isRecord(value)) return false;
  switch (value.decision) {
    case 'exhausted':
      return (
        hasExactShape(value, EXHAUSTED_SHAPE) &&
        Number.isSafeInteger(value.attempts) &&
        Number(value.attempts) > 0
      );
    case 'declined':
      return (
        hasExactShape(value, DECLINED_SHAPE) &&
        (value.because === 'side_effects' ||
          value.because === 'observable_output' ||
          value.because === 'policy' ||
          value.because === 'budget')
      );
    default:
      return false;
  }
}
