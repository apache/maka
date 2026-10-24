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

import type { ProviderRetryReason } from '@maka/core/events';
import { assertExactKeys, requireCount, requireRecord } from './codec.js';
import { invalidProtocolFrame } from './errors.js';

interface RetryAttempt {
  attempt: number;
  maxAttempts: number;
  reason: ProviderRetryReason;
}

export type TurnProviderRetry =
  | (RetryAttempt & { phase: 'scheduled'; delayMs: number; ts?: number })
  | (RetryAttempt & { phase: 'started' });

const RETRY_REASONS = new Set<ProviderRetryReason>([
  'stream_truncated',
  'network',
  'provider_capacity',
  'provider_unavailable',
  'rate_limit',
  'timeout',
  'unknown',
]);

export function decodeTurnProviderRetry(value: unknown): TurnProviderRetry {
  const record = requireRecord(value, 'Turn provider retry');
  const common = decodeAttempt(record);

  if (record.phase === 'started') {
    assertExactKeys(record, 'started Turn provider retry', [
      'phase',
      'attempt',
      'maxAttempts',
      'reason',
    ]);
    return { phase: 'started', ...common };
  }

  if (record.phase === 'scheduled') {
    const keys = ['phase', 'attempt', 'maxAttempts', 'delayMs', 'reason'];
    assertExactKeys(
      record,
      'scheduled Turn provider retry',
      record.ts === undefined ? keys : [...keys, 'ts'],
    );
    return {
      phase: 'scheduled',
      ...common,
      delayMs: requireCount(record.delayMs, 'delayMs'),
      ...(record.ts === undefined ? {} : { ts: requireCount(record.ts, 'ts') }),
    };
  }

  throw invalidProtocolFrame('Invalid Turn provider retry phase');
}

function decodeAttempt(record: Record<string, unknown>): RetryAttempt {
  const attempt = positiveCount(record.attempt, 'attempt');
  const maxAttempts = positiveCount(record.maxAttempts, 'maxAttempts');
  if (attempt > maxAttempts) throw invalidProtocolFrame('Invalid Turn provider retry attempt');
  if (!RETRY_REASONS.has(record.reason as ProviderRetryReason)) {
    throw invalidProtocolFrame('Invalid Turn provider retry reason');
  }
  return { attempt, maxAttempts, reason: record.reason as ProviderRetryReason };
}

function positiveCount(value: unknown, label: string): number {
  const count = requireCount(value, label);
  if (count === 0) throw invalidProtocolFrame(`Invalid ${label}`);
  return count;
}
