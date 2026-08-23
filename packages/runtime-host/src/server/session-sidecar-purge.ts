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

import type { InteractiveArtifactStoreWriter } from '@maka/storage/artifact-stores';
import type { InteractiveTaskLedgerWriter } from '@maka/storage/task-ledger-authority';

export interface SessionSidecarPurgeAuthority {
  readonly artifacts: Pick<InteractiveArtifactStoreWriter, 'purgeSessionArtifacts'>;
  readonly taskLedger: Pick<InteractiveTaskLedgerWriter, 'purgeConversationTaskLedger'>;
  readonly purgeOperationalState: (sessionId: string) => Promise<void>;
}

export async function purgeSessionSidecars(
  authority: SessionSidecarPurgeAuthority,
  sessionId: string,
): Promise<void> {
  const outcomes = await Promise.allSettled([
    authority.artifacts.purgeSessionArtifacts(sessionId),
    authority.taskLedger.purgeConversationTaskLedger(sessionId),
    authority.purgeOperationalState(sessionId),
  ]);
  const failures = outcomes.flatMap((outcome) =>
    outcome.status === 'rejected' ? [outcome.reason] : [],
  );
  if (failures.length > 0) {
    throw new AggregateError(failures, `Session ${sessionId} sidecars could not be purged`);
  }
}
