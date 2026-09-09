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

import type { AttachmentRef } from '@maka/core/events';
import { WORKHUB_COORDINATION_SESSION_ID } from '@maka/core/session';
import type { InteractiveArtifactStoreWriter } from '@maka/storage/artifact-stores';
import type { HostArtifactCoordinator } from './artifact-coordinator.js';
import { WorkHubActionEffectFailure } from './workhub-coordination-action-gate.js';

/** Preserve canonical ownership when a Coordination message is delegated. */
export async function copyWorkHubAttachmentsToTarget(
  store: Pick<InteractiveArtifactStoreWriter, 'copyConversationArtifacts'>,
  artifacts: Pick<HostArtifactCoordinator, 'validateTurnAttachments'>,
  targetSessionId: string,
  attachments: readonly AttachmentRef[],
): Promise<AttachmentRef[]> {
  const invalid = await artifacts.validateTurnAttachments(
    WORKHUB_COORDINATION_SESSION_ID,
    attachments,
  );
  if (invalid) throw new WorkHubActionEffectFailure('operation_conflict', invalid);
  const ids = attachments.map((attachment) => {
    if (attachment.ref.kind !== 'session_file') throw new Error('Invalid WorkHub attachment');
    return attachment.ref.relativePath;
  });
  const copied = await store.copyConversationArtifacts({
    sourceSessionId: WORKHUB_COORDINATION_SESSION_ID,
    targetSessionId,
    turnIds: [],
    includeArtifactIds: ids,
    existingTarget: 'reuse_verified',
  });
  return attachments.map((attachment, index) => {
    const relativePath = copied.artifactIds.get(ids[index]!);
    if (!relativePath)
      throw new WorkHubActionEffectFailure(
        'operation_conflict',
        'WorkHub attachment was not copied',
      );
    return {
      ...attachment,
      ref: { kind: 'session_file', sessionId: targetSessionId, relativePath },
    };
  });
}
