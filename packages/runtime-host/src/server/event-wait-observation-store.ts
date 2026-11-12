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

import {
  decodeAnyEventWaitRecord,
  type AnyEventWaitRecord,
  type EventWaitRecord,
} from '@maka/core/event-wait';
import { authenticateInteractiveEventWaitAuthorityWriter } from '@maka/storage/event-wait-authority';
import type {
  InteractiveEventWaitAuthorityWriter,
  CommitEventWaitResult,
} from '@maka/storage/event-wait-authority';

export interface ObservationWaitSnapshot<Record extends AnyEventWaitRecord = EventWaitRecord> {
  readonly authorityRevision: number;
  readonly record: Record;
}
export type ObservationCommitResult<Record extends AnyEventWaitRecord = EventWaitRecord> =
  | { readonly kind: 'committed'; readonly snapshot: ObservationWaitSnapshot<Record> }
  | Exclude<CommitEventWaitResult, { kind: 'committed' }>;
/** Internal composition port. The owner must enforce its lease, revision and lifecycle on writes. */
export interface EventWaitObservationStore<Record extends AnyEventWaitRecord = EventWaitRecord>
  extends Pick<
    InteractiveEventWaitAuthorityWriter,
    | 'readSourceCooldown'
    | 'extendSourceCooldown'
    | 'reserveSourceDispatch'
    | 'completeSourceDispatch'
  > {
  read(
    input: Parameters<InteractiveEventWaitAuthorityWriter['read']>[0],
  ): Promise<ObservationWaitSnapshot<Record> | null>;
  listByStatus(
    input: Parameters<InteractiveEventWaitAuthorityWriter['listByStatus']>[0],
  ): Promise<{ items: readonly ObservationWaitSnapshot<Record>[]; nextCursor: string | null }>;
  listForObservation(
    input: Parameters<InteractiveEventWaitAuthorityWriter['listForObservation']>[0],
  ): Promise<readonly ObservationWaitSnapshot<Record>[]>;
  commit(input: {
    sessionId: string;
    waitId: string;
    expectedAuthorityRevision: number | null;
    record: Record;
  }): Promise<ObservationCommitResult<Record>>;
}

/** One scheduler and source budget for all durable interactive consumers. */
export function interactiveEventWaitObservationStore(
  authority: InteractiveEventWaitAuthorityWriter,
): EventWaitObservationStore<AnyEventWaitRecord> {
  const store = authenticateInteractiveEventWaitAuthorityWriter(authority);
  return {
    read: (input) => store.readAny(input),
    listByStatus: (input) => store.listAny(input),
    listForObservation: (input) => store.listAnyForObservation(input),
    readSourceCooldown: (input) => store.readSourceCooldown(input),
    extendSourceCooldown: (input) => store.extendSourceCooldown(input),
    reserveSourceDispatch: (input) => store.reserveSourceDispatch(input),
    completeSourceDispatch: (input) => store.completeSourceDispatch(input),
    commit: (input) =>
      store.commitAny({ ...input, record: decodeAnyEventWaitRecord(input.record) }),
  };
}
