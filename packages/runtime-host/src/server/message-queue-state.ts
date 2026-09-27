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

import { exactQueueReorder } from '@maka/core/message-queue-order';

interface QueueEntryIdentity {
  readonly entryId: string;
  readonly messageId: string;
}

interface QueueCollections<Entry extends QueueEntryIdentity> {
  steering: Entry[];
  followup: Entry[];
  readonly inFlight: ReadonlyMap<string, Entry>;
}

export interface QueuedEntryLocation<Entry extends QueueEntryIdentity> {
  readonly lane: 'steering' | 'followup';
  readonly index: number;
  readonly entry: Entry;
}

export function locateQueuedEntry<Entry extends QueueEntryIdentity>(
  state: QueueCollections<Entry>,
  entryId: string,
): QueuedEntryLocation<Entry> | undefined {
  for (const lane of ['steering', 'followup'] as const) {
    const index = state[lane].findIndex((entry) => entry.entryId === entryId);
    const entry = index < 0 ? undefined : state[lane][index];
    if (entry) return { lane, index, entry };
  }
  return undefined;
}

export function hasInFlightEntry<Entry extends QueueEntryIdentity>(
  state: QueueCollections<Entry>,
  entryId: string,
): boolean {
  return [...state.inFlight.values()].some((entry) => entry.entryId === entryId);
}

export function removeQueuedEntry<Entry extends QueueEntryIdentity>(
  state: QueueCollections<Entry>,
  location: QueuedEntryLocation<Entry>,
): Entry {
  const [removed] = state[location.lane].splice(location.index, 1);
  if (removed !== location.entry) throw new Error('Queued entry location changed before commit');
  return removed;
}

export function commitFollowupPromotion<Entry extends QueueEntryIdentity>(
  state: QueueCollections<Entry>,
  location: QueuedEntryLocation<Entry>,
  promoted: Entry,
): void {
  if (location.lane !== 'followup') throw new Error('Only follow-up entries can be promoted');
  removeQueuedEntry(state, location);
  state.steering.push(promoted);
}

export function planQueueReorder<Entry extends QueueEntryIdentity>(
  state: QueueCollections<Entry>,
  entryIds: readonly string[],
):
  | {
      readonly lane: 'steering' | 'followup';
      readonly entries: readonly Entry[];
      readonly changed: boolean;
    }
  | undefined {
  const lane = state.steering.some((entry) => entry.entryId === entryIds[0])
    ? 'steering'
    : 'followup';
  const reorder = exactQueueReorder(state[lane], entryIds);
  return reorder ? { lane, entries: reorder.entries, changed: reorder.changed } : undefined;
}

export function commitQueueReorder<Entry extends QueueEntryIdentity>(
  state: QueueCollections<Entry>,
  lane: 'steering' | 'followup',
  entries: readonly Entry[],
): void {
  state[lane] = [...entries];
}
