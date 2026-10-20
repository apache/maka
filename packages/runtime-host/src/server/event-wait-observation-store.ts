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

import type { ObservedEventWaitRecord } from '@maka/core/event-wait';
import type {
  InteractiveEventWaitAuthorityWriter,
  CommitEventWaitResult,
} from '@maka/storage/event-wait-authority';

export interface ObservationWaitSnapshot {
  readonly authorityRevision: number;
  readonly record: ObservedEventWaitRecord;
}
export type ObservationCommitResult =
  | { readonly kind: 'committed'; readonly snapshot: ObservationWaitSnapshot }
  | Exclude<CommitEventWaitResult, { kind: 'committed' }>;
/** Internal composition port. The owner must enforce its lease, revision and lifecycle on writes. */
export interface EventWaitObservationStore
  extends Pick<
    InteractiveEventWaitAuthorityWriter,
    | 'readSourceCooldown'
    | 'extendSourceCooldown'
    | 'reserveSourceDispatch'
    | 'completeSourceDispatch'
  > {
  read(
    input: Parameters<InteractiveEventWaitAuthorityWriter['read']>[0],
  ): Promise<ObservationWaitSnapshot | null>;
  listByStatus(
    input: Parameters<InteractiveEventWaitAuthorityWriter['listByStatus']>[0],
  ): Promise<{ items: readonly ObservationWaitSnapshot[]; nextCursor: string | null }>;
  listForObservation(
    input: Parameters<InteractiveEventWaitAuthorityWriter['listForObservation']>[0],
  ): Promise<readonly ObservationWaitSnapshot[]>;
  commit(input: {
    sessionId: string;
    waitId: string;
    expectedAuthorityRevision: number | null;
    record: ObservedEventWaitRecord;
  }): Promise<ObservationCommitResult>;
}
