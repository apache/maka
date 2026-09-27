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

import type { ContextUsageReading } from '@maka/ui';
import type { LiveContextUsage } from './live-context-usage.js';

export interface LatestRequestUsageAnchor {
  inputTokens: number;
  outputTokens?: number;
  modelId?: string;
  connectionId?: string;
}

export interface LatestRequestUsageRow {
  readonly type: string;
  readonly ts?: number;
  readonly kind?: string;
  readonly lastRequestAnchor?: LatestRequestUsageAnchor;
}

export type LatestRequestUsage =
  | { readonly kind: 'tokens'; readonly tokens: number }
  | { readonly kind: 'compacted'; readonly at?: number }
  | undefined;

/**
 * Read the newest route-matching measurement or compaction from the session tail.
 * Anchorless usage rows (including manual compaction usage) carry no measurement.
 * A compaction invalidates earlier measurements until a later request settles.
 */
export function selectLatestRequestUsage(
  messages: readonly LatestRequestUsageRow[],
  model: string | undefined,
  route: { llmConnectionId?: string } | undefined,
): LatestRequestUsage {
  const connectionId = route?.llmConnectionId;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    // Ledger order decides whether the latest anchor has been superseded.
    if (message?.type === 'system_note' && message.kind === 'context_compacted') {
      return { kind: 'compacted', ...(message.ts !== undefined ? { at: message.ts } : {}) };
    }
    if (message?.type !== 'token_usage') continue;
    const anchor = message.lastRequestAnchor;
    if (!anchor) continue;
    if (model === undefined || connectionId === undefined) return undefined;
    if (anchor.modelId !== model || anchor.connectionId !== connectionId) return undefined;
    if (!Number.isFinite(anchor.inputTokens) || anchor.inputTokens <= 0) return undefined;
    const output = Number.isFinite(anchor.outputTokens ?? 0) ? Math.max(0, anchor.outputTokens ?? 0) : 0;
    return {
      kind: 'tokens',
      tokens: anchor.inputTokens + output,
    };
  }
  return undefined;
}

/**
 * Prefer the per-request snapshot to the turn-end anchor. A known compaction
 * suppresses snapshots that cannot be shown to postdate its transcript note.
 * This preserves the existing timestamp policy; the note may be recorded later
 * than the actual fold, so it is not a causal checkpoint identifier.
 */
export function resolveContextUsage(input: {
  readonly latestRequestUsage: LatestRequestUsage;
  readonly live?: LiveContextUsage;
}): ContextUsageReading {
  const { latestRequestUsage, live } = input;
  if (
    latestRequestUsage?.kind === 'compacted' &&
    (live?.completedAt === undefined ||
      latestRequestUsage.at === undefined ||
      latestRequestUsage.at >= live.completedAt)
  ) {
    return { kind: 'stale', reason: 'compaction' };
  }
  if (live) {
    return {
      kind: 'measured',
      tokens: live.usageTokens,
      ...(live.contextWindow !== undefined ? { meteredWindow: live.contextWindow } : {}),
    };
  }
  if (latestRequestUsage?.kind === 'tokens')
    return { kind: 'measured', tokens: latestRequestUsage.tokens };
  return { kind: 'unavailable' };
}
