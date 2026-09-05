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

import { randomUUID } from 'node:crypto';
import { generalizedErrorMessage } from '@maka/core/redaction';
import { pricingModelKey } from '@maka/core/usage-stats/pricing';
import type { LlmCallRecord, PricingConfig } from '@maka/core/usage-stats/types';
import { computeCost } from './cost.js';
import type { TelemetryRepoLite } from './types.js';

export interface LlmRecorderDeps {
  repo: Pick<TelemetryRepoLite, 'insertLlmCall'>;
  lookupPricing: (modelKey: string) => PricingConfig | null;
}

export async function recordLlmCall(deps: LlmRecorderDeps, record: LlmCallRecord): Promise<void> {
  try {
    await recordLlmCallStrict(deps, record);
  } catch (error) {
    console.error(`[telemetry] recordLlmCall failed: ${generalizedErrorMessage(error)}`);
  }
}

/** Records one LLM call and preserves persistence failure for authority owners. */
export async function recordLlmCallStrict(
  deps: LlmRecorderDeps,
  record: LlmCallRecord,
): Promise<void> {
  const cacheHitInputTokens = record.cacheHitInputTokens ?? record.cachedInputTokens ?? 0;
  const cacheWriteInputTokens = record.cacheWriteInputTokens ?? 0;
  const derivedCacheMissInputTokens = record.cacheMissInputTokens === undefined;
  const cacheMissInputTokens =
    record.cacheMissInputTokens ??
    Math.max(0, record.inputTokens - cacheHitInputTokens - cacheWriteInputTokens);
  const cacheMissInputSource =
    record.cacheMissInputSource ?? (derivedCacheMissInputTokens ? 'derived' : undefined);
  const cachedInputTokens = cacheHitInputTokens;
  const reasoningTokens = record.reasoningTokens ?? 0;
  const totalTokens =
    record.totalTokens ?? record.inputTokens + record.outputTokens + reasoningTokens;
  const costUsd =
    record.costUsd ??
    computeCost(
      {
        inputTokens: record.inputTokens,
        outputTokens: record.outputTokens,
        cacheHitInputTokens,
        cacheMissInputTokens,
        cacheWriteInputTokens,
      },
      deps.lookupPricing(pricingModelKey(record.providerId, record.modelId)),
    ).totalCost;
  const ts = record.startedAt + record.latencyMs;
  const recordId = record.callId
    ? `usage_${record.callId}`
    : `usage_${record.turnId ?? randomUUID()}`;
  await deps.repo.insertLlmCall({
    ...record,
    id: recordId,
    cacheHitInputTokens,
    cacheMissInputTokens,
    ...(cacheMissInputSource !== undefined ? { cacheMissInputSource } : {}),
    cachedInputTokens,
    cacheWriteInputTokens,
    reasoningTokens,
    totalTokens,
    costUsd,
    date: new Date(ts).toISOString().slice(0, 10),
    ts,
  });
}
