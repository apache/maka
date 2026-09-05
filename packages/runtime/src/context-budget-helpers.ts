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

import { createHash } from 'node:crypto';
import type { RuntimeEvent } from '@maka/core/runtime-event';

/**
 * Cross-block shared pure helpers for the context-budget and history-compaction
 * domain. Extracted from `context-budget.ts` so sibling
 * modules can reuse them without a reverse import into `context-budget.ts`.
 *
 * These are intentionally dependency-free (only `node:crypto` and the
 * `RuntimeEvent` type); no domain policy types live here. Sizing a
 * RuntimeEvent is NOT such a helper — it must read the effective model
 * projection — so `estimateRuntimeEventChars`/`estimateRuntimeEventsTokens`/
 * `groupEventsByTurn` live with the reducer in `model-history.ts`.
 */

export function estimateTokens(chars: number, charsPerToken = 4): number {
  if (chars <= 0) return 0;
  return Math.ceil(chars / Math.max(1, charsPerToken));
}

export function stableJsonLength(value: unknown): number {
  if (value === undefined) return 0;
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return String(value).length;
  }
}

export function turnKey(event: RuntimeEvent): string {
  return event.turnId || '<unknown-turn>';
}

export function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))].sort();
}

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export function stableStringify(value: unknown): string {
  if (value === undefined) return '';
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return String(value);
  }
}

export function finitePositive(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

export function utf8ByteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

export function optionalNonNegativeFiniteNumber(value: unknown): boolean {
  return value === undefined || (typeof value === 'number' && Number.isFinite(value) && value >= 0);
}
