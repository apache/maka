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

export function dossierInterrupt(
  seen: ReadonlyMap<string, number> | null,
  snapshot: DossiersSnapshot,
) {
  // latestInterrupt is the committed lastNotifiedRevision, reason and time, independent
  // of the dossier's material revision. Quiet updates can repeat it indefinitely.
  const event = snapshot.latestInterrupt;
  if (!event || (seen?.get(event.topicId) ?? 0) >= event.revision)
    return { seen: seen ?? new Map<string, number>(), notification: null };
  const next = new Map(seen).set(event.topicId, event.revision);
  const row = snapshot.dossiers.find((item) => item.topicId === event.topicId);
  const notification =
    seen !== null && snapshot.notificationsEnabled && row && !row.muted
      ? { tag: discoveryTag(row.topicId), title: row.title, body: event.reason }
      : null;
  return { seen: next, notification };
}
