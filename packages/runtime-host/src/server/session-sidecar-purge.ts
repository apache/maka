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
import type { InteractiveSessionTodoWriter } from '@maka/storage/session-todo-authority';
import type { InteractiveContextOffloadWriter } from '@maka/storage/context-offload-store';

export interface SessionSidecarPurgeAuthority {
  readonly artifacts: Pick<InteractiveArtifactStoreWriter, 'purgeSessionArtifacts'>;
  readonly sessionTodo: Pick<InteractiveSessionTodoWriter, 'purgeSessionState'>;
  readonly contextOffload?: Pick<InteractiveContextOffloadWriter, 'retireSession'>;
  readonly purgeOperationalState: (sessionId: string) => Promise<void>;
  readonly onArtifactsPurged?: (sessionId: string) => void;
}

export async function purgeSessionSidecars(
  authority: SessionSidecarPurgeAuthority,
  sessionId: string,
): Promise<void> {
  const [artifactPurge, ...sidecarPurges] = await Promise.allSettled([
    authority.artifacts.purgeSessionArtifacts(sessionId),
    authority.sessionTodo.purgeSessionState(sessionId),
    ...(authority.contextOffload ? [authority.contextOffload.retireSession(sessionId)] : []),
    authority.purgeOperationalState(sessionId),
  ]);
  // Once Artifacts are purged their previews must stop serving, even when a
  // sibling sidecar fails and the aggregate error is thrown below.
  if (artifactPurge.status === 'fulfilled') authority.onArtifactsPurged?.(sessionId);
  const failures = [artifactPurge, ...sidecarPurges].flatMap((outcome) =>
    outcome.status === 'rejected' ? [outcome.reason] : [],
  );
  if (failures.length > 0) {
    throw new AggregateError(failures, `Session ${sessionId} sidecars could not be purged`);
  }
}
