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
import type {
  ContextUsageSnapshot,
  ContextUsageTokens,
} from './context-usage-snapshot.js';
import type { LiveContextReading } from './live-context-usage.js';

export interface LatestRequestUsageAnchor {
  inputTokens: number;
  outputTokens?: number;
  completedAt?: number;
  modelId?: string;
  connectionId?: string;
}

export interface LatestRequestUsageRow {
  readonly type: string;
  readonly ts?: number;
  readonly kind?: string;
  readonly turnId?: string;
  readonly lastRequestAnchor?: LatestRequestUsageAnchor;
}

/**
 * The durable half of the gauge's answer — what the transcript's own rows
 * select — in the same shape the live tracker reports, so
 * `resolveContextUsage` can arbitrate the two on one union.
 */
export type LatestRequestUsage = ContextUsageSnapshot | undefined;

/**
 * Read the newest route-matching measurement or compaction from the session tail.
 * Anchorless usage rows (including manual compaction usage) carry no measurement.
 * A compaction invalidates earlier measurements until a later request settles.
 *
 * Ledger position decides the scan order, but the candidate is arbitrated by
 * event time: settlement persists the usage row AFTER the compaction notes even
 * when the anchored request completed BEFORE the compaction — its retry never
 * finished (#5547) — so a boundary row behind the newest anchored row can still
 * supersede it when the compaction's apply time postdates the anchor's completion.
 */
export function selectLatestRequestUsage(
  messages: readonly LatestRequestUsageRow[],
  model: string | undefined,
  route: { llmConnectionId?: string } | undefined,
): LatestRequestUsage {
  const connectionId = route?.llmConnectionId;
  // The newest anchored usage row, held while the scan behind it looks for a
  // boundary that postdates its completion. A second anchored row settles it:
  // under ordered writes every boundary behind that row is strictly older.
  let pendingTokens: ContextUsageTokens | undefined;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.type === 'system_note' && message.kind === 'context_compaction_applied') {
      // Written the moment the compaction is applied, so its row time IS the
      // boundary time — mid-turn compactions land it mid-turn, not at settlement.
      if (!pendingTokens) {
        return { kind: 'compacted', ...(message.ts !== undefined ? { at: message.ts } : {}) };
      }
      return orderTokensAgainstBoundary(pendingTokens, message.ts);
    }
    if (message?.type === 'system_note' && message.kind === 'context_compacted') {
      // The settlement-time display row: the compaction it describes was applied
      // earlier in the same turn and recorded its own boundary row.
      const appliedAt = latestCompactionAppliedAt(messages, index, message.turnId);
      const at = appliedAt ?? message.ts;
      if (!pendingTokens) {
        return { kind: 'compacted', ...(at !== undefined ? { at } : {}) };
      }
      return orderTokensAgainstBoundary(pendingTokens, at);
    }
    if (message?.type !== 'token_usage') continue;
    const anchor = message.lastRequestAnchor;
    if (!anchor) continue;
    if (pendingTokens) return pendingTokens;
    if (model === undefined || connectionId === undefined) return undefined;
    if (anchor.modelId !== model || anchor.connectionId !== connectionId) return undefined;
    if (!Number.isFinite(anchor.inputTokens) || anchor.inputTokens <= 0) return undefined;
    const output = Number.isFinite(anchor.outputTokens ?? 0) ? Math.max(0, anchor.outputTokens ?? 0) : 0;
    pendingTokens = {
      kind: 'tokens',
      tokens: anchor.inputTokens + output,
      // The row is persisted after request settlement (and sometimes after a
      // compaction note). Its write time cannot order its own snapshot.
      ...(anchor.completedAt !== undefined ? { at: anchor.completedAt } : {}),
    };
  }
  return pendingTokens;
}

/**
 * Arbitration between the position-newest anchored usage row and a boundary
 * row found behind it. The compaction supersedes the measurement only when its
 * apply time provably postdates the anchored request's completion; a missing
 * completion or boundary time cannot establish that order, so the candidate
 * stands.
 */
function orderTokensAgainstBoundary(
  reading: ContextUsageTokens,
  boundaryAt: number | undefined,
): LatestRequestUsage {
  if (
    reading.at !== undefined &&
    boundaryAt !== undefined &&
    boundaryAt >= reading.at
  ) {
    return { kind: 'compacted', at: boundaryAt };
  }
  return reading;
}

/**
 * Find the apply-time boundary behind a settlement `context_compacted` row.
 * The display note is written when the turn settles while the compaction it
 * describes was applied mid-turn; between the two rows sit only that turn's
 * post-compaction output — the turn's own usage row lands after the note — so the
 * first relevant row behind the note is the matching apply row when one was
 * recorded. A different turn's apply row, an older display note, a usage
 * row, or the head of the log all mean the note's own write time is all
 * there is.
 */
function latestCompactionAppliedAt(
  messages: readonly LatestRequestUsageRow[],
  noteIndex: number,
  turnId: string | undefined,
): number | undefined {
  for (let index = noteIndex - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.type === 'token_usage') return undefined;
    if (message?.type !== 'system_note') continue;
    if (message.kind === 'context_compaction_applied') {
      return message.turnId === turnId ? message.ts : undefined;
    }
    if (message.kind === 'context_compacted') return undefined;
  }
  return undefined;
}

/**
 * Resolve the context-usage reading the UI can display from the live Turn's
 * latest request snapshot and the durable transcript's token-usage anchors
 * and compaction notes. Choose the newest reading whose relative order can
 * be established; after a compaction, only a measurement proven to have
 * completed later may be shown, otherwise report the usage as stale.
 */
export function resolveContextUsage(input: {
  readonly latestRequestUsage: LatestRequestUsage;
  readonly live?: LiveContextReading;
}): ContextUsageReading {
  const { latestRequestUsage, live } = input;
  // A live boundary holds the gauge on "compacted" until a durable
  // measurement provably settled after it lands.
  if (live?.kind === 'compacted') {
    if (
      latestRequestUsage?.kind === 'tokens' &&
      latestRequestUsage.at !== undefined &&
      live.at !== undefined &&
      latestRequestUsage.at > live.at
    ) {
      return { kind: 'measured', tokens: latestRequestUsage.tokens };
    }
    return { kind: 'stale', reason: 'compaction' };
  }
  // A durable boundary does the same to any live measurement that cannot
  // prove it settled after the boundary — an untimed one included.
  if (
    latestRequestUsage?.kind === 'compacted' &&
    (live?.kind !== 'tokens' ||
      live.at === undefined ||
      latestRequestUsage.at === undefined ||
      latestRequestUsage.at >= live.at)
  ) {
    return { kind: 'stale', reason: 'compaction' };
  }
  if (
    latestRequestUsage?.kind === 'tokens' &&
    latestRequestUsage.at !== undefined &&
    (live?.kind !== 'tokens' || live.at === undefined || latestRequestUsage.at > live.at)
  ) {
    return { kind: 'measured', tokens: latestRequestUsage.tokens };
  }
  if (live?.kind === 'tokens') {
    return {
      kind: 'measured',
      tokens: live.tokens,
      ...(live.contextWindow !== undefined ? { contextWindow: live.contextWindow } : {}),
    };
  }
  if (latestRequestUsage?.kind === 'tokens')
    return { kind: 'measured', tokens: latestRequestUsage.tokens };
  return { kind: 'unavailable' };
}
