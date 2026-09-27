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
import type { ModelFailureKind } from './model-protocol.js';

const MAX_TIMER_DELAY_MS = 2_147_483_647;

const RETRY_REASON: Record<ModelFailureKind, ProviderRetryReason | null> = {
  abort: null,
  auth: null,
  context_overflow: null,
  network: 'network',
  provider_billing: null,
  provider_capacity: 'provider_capacity',
  provider_unavailable: 'provider_unavailable',
  rate_limit: 'rate_limit',
  request_rejected: null,
  stream_truncated: 'stream_truncated',
  timeout: 'timeout',
  unknown: null,
};

export interface ProviderRetryDecision {
  readonly reason: ProviderRetryReason | null;
  readonly retryAfterMs?: number;
}

/** One pure policy decision consumed by both Runtime retrying and Host projection. */
export function providerRetryDecision(
  kind: ModelFailureKind,
  headers: Readonly<Record<string, string>> = {},
): ProviderRetryDecision {
  const reason = RETRY_REASON[kind];
  if (reason === null) return { reason };
  const delay = retryAfterMs(headers);
  return delay === undefined ? { reason } : { reason, retryAfterMs: delay };
}

export function providerRetryReason(kind: ModelFailureKind): ProviderRetryReason | null {
  return providerRetryDecision(kind).reason;
}

export function responseHeadersFromError(error: unknown): Record<string, string> | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const value = (error as { responseHeaders?: unknown }).responseHeaders;
  if (typeof value !== 'object' || value === null) return undefined;
  const headers: Record<string, string> = {};
  if (value instanceof Headers) {
    value.forEach((header, key) => {
      headers[key.toLowerCase()] = header;
    });
    return headers;
  }
  for (const [key, header] of Object.entries(value)) {
    if (typeof header === 'string') headers[key.toLowerCase()] = header;
  }
  return headers;
}

export function retryAfterMs(headers: Readonly<Record<string, string>>): number | undefined {
  const bounded = (delayMs: number): number | undefined =>
    Number.isFinite(delayMs) && delayMs > 0 && delayMs <= MAX_TIMER_DELAY_MS
      ? Math.ceil(delayMs)
      : undefined;
  const milliseconds = headers['retry-after-ms'];
  if (milliseconds !== undefined) {
    const parsed = bounded(Number(milliseconds));
    if (parsed !== undefined) return parsed;
  }
  const retryAfter = headers['retry-after'];
  if (retryAfter === undefined) return undefined;
  const seconds = Number(retryAfter);
  return bounded(Number.isFinite(seconds) ? seconds * 1_000 : Date.parse(retryAfter) - Date.now());
}
