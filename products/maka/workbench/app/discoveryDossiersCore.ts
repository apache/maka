/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements. See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership. The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License. You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied. See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */
import type { Output } from './host';
import { fileURLToPath } from 'url';

export type DossiersSnapshot = Output<'agent', 'watchDossiers'>;
export type DossierSummary = DossiersSnapshot['dossiers'][number];
export type DossierDetail = NonNullable<Output<'agent', 'dossier'>>;

export function leadFilePaths(uris: readonly string[], previous: readonly string[] = []): string[] {
  return [...new Set([...previous, ...uris.map((uri) => fileURLToPath(uri))])];
}

export type DossierSelection = { topicId: string; requested?: true } | null;

export function pinDossier(
  dossiers: readonly DossierSummary[],
  selection: DossierSelection,
): DossierSelection {
  if (selection && dossiers.some((row) => row.topicId === selection.topicId))
    return selection.requested ? { topicId: selection.topicId } : selection;
  // A lead receipt or notification can arrive before the corresponding list snapshot.
  if (selection?.requested) return selection;
  return dossiers.length ? { topicId: dossiers[0]!.topicId } : null;
}

export const discoveryTag = (topicId: string) => `discovery:${topicId}`;
export function notificationTarget(tag: unknown) {
  if (typeof tag !== 'string' || !tag) return null;
  if (!tag.startsWith('discovery:')) return { kind: 'session' as const, id: tag };
  const id = tag.slice('discovery:'.length);
  return id ? { kind: 'discovery' as const, id } : null;
}

export type DossierNotification = { tag: string; title: string; body: string };

export function dossierInterrupt(
  seen: ReadonlyMap<string, number> | null,
  snapshot: DossiersSnapshot,
) {
  const next = new Map(seen);
  const notifications: DossierNotification[] = [];
  for (const row of snapshot.dossiers) {
    if (row.lastNotifiedRevision <= (next.get(row.topicId) ?? 0)) continue;
    next.set(row.topicId, row.lastNotifiedRevision);
    if (seen && snapshot.notificationsEnabled && !row.muted && row.lastInterruptAt != null) {
      notifications.push({
        tag: discoveryTag(row.topicId),
        title: row.title,
        body: row.lastInterruptReason ?? '',
      });
    }
  }
  return { seen: next, notifications };
}

type PendingAction = DossierDetail['pendingActions'][number];

export function pendingActionControls(
  action: Pick<PendingAction, 'status' | 'receipt'>,
  busy = false,
) {
  const awaiting = action.status === 'awaiting_confirm';
  const stale = action.status === 'stale';
  const receipt = action.receipt;
  const reason =
    receipt && typeof receipt === 'object' && 'reason' in receipt ? receipt.reason : null;
  const notice = stale
    ? reason === 'expired'
      ? 'Dossier action expired'
      : reason === 'watch' || reason === 'authorization_unavailable'
        ? 'Dossier action stale'
        : 'Dossier source changed'
    : action.status === 'unknown_pending_receipt'
      ? 'Dossier check receipt'
      : null;
  return {
    showConfirm: awaiting || stale,
    confirm: awaiting && !busy,
    showDismiss: awaiting || stale,
    dismiss: (awaiting || stale) && !busy,
    notice,
  } as const;
}
