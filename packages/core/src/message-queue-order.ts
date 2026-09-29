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

export interface QueueEntryIdentity {
  readonly entryId: string;
}

export interface ExactQueueReorder<T> {
  readonly entries: readonly T[];
  readonly changed: boolean;
}

export function exactQueueReorder<T extends QueueEntryIdentity>(
  current: readonly T[],
  requestedEntryIds: readonly string[],
): ExactQueueReorder<T> | undefined {
  if (requestedEntryIds.length !== current.length) return undefined;
  const remaining = new Map(current.map((entry) => [entry.entryId, entry]));
  if (remaining.size !== current.length) return undefined;
  const entries: T[] = [];
  for (const entryId of requestedEntryIds) {
    const entry = remaining.get(entryId);
    if (!entry) return undefined;
    remaining.delete(entryId);
    entries.push(entry);
  }
  return {
    entries,
    changed: entries.some((entry, index) => current[index] !== entry),
  };
}

export function moveQueueEntryId(
  currentEntryIds: readonly string[],
  sourceEntryId: string,
  targetEntryId: string,
): readonly string[] | undefined {
  const sourceIndex = currentEntryIds.indexOf(sourceEntryId);
  const targetIndex = currentEntryIds.indexOf(targetEntryId);
  if (sourceIndex === -1 || targetIndex === -1 || sourceIndex === targetIndex) return undefined;
  const entries = [...currentEntryIds];
  entries.splice(sourceIndex, 1);
  entries.splice(targetIndex, 0, sourceEntryId);
  return entries;
}
