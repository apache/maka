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

import { createHash } from 'node:crypto';
import { messageContentDigest, normalizeMessageContent } from '@maka/core/events';
import {
  WORKHUB_COORDINATION_SESSION_ID,
  WORKHUB_COORDINATION_SESSION_ROLE,
  type WorkHubDelegationAssignedMessage,
} from '@maka/core/session';
import type { SessionAuthorityStore } from '../../session-store-contract.js';

export async function createCoordinationSession(
  store: Pick<SessionAuthorityStore, 'createStableSession'>,
  root: string,
): Promise<void> {
  await store.createStableSession({
    sessionId: WORKHUB_COORDINATION_SESSION_ID,
    requestFingerprint: `sha256:${'a'.repeat(64)}`,
    input: {
      cwd: root,
      name: 'WorkHub',
      role: WORKHUB_COORDINATION_SESSION_ROLE,
      llmConnectionSlug: 'test',
      model: 'test',
      permissionMode: 'explore',
      toolProfile: 'workhub-coordination-v1',
    },
  });
}

export type AssignmentRequest = ReturnType<typeof assignmentRequest>;

export function assignmentRequest(
  actionId: string,
  targetSessionId: string,
  targetSessionName: string,
  targetTurnId: string,
) {
  const suffix = createHash('sha256').update(actionId, 'utf8').digest('hex').slice(0, 48);
  const content = normalizeMessageContent({ text: 'Continue payment work' });
  const assignment: WorkHubDelegationAssignedMessage = {
    type: 'workhub_coordination',
    id: `wha_${suffix}`,
    turnId: actionId,
    ts: 10,
    schemaVersion: 1,
    kind: 'delegation_assigned',
    actionId,
    actionFingerprint: `sha256:${'c'.repeat(64)}`,
    coordinationTurnId: actionId,
    targetSessionId,
    targetSessionName,
    targetTurnId,
    targetMessageId: `whm_${suffix}`,
    delegationId: `whd_${suffix}`,
    disposition: 'delegate_existing',
    userText: content.text,
  };
  return {
    assignment,
    admission: {
      sessionId: targetSessionId,
      turnId: targetTurnId,
      runId: `whr_${suffix}`,
      messageId: assignment.targetMessageId,
      content,
      submittedContentDigest: messageContentDigest(content),
      submittedPlacement: 'current_turn' as const,
      placement: 'current_turn' as const,
      disposition: 'steering' as const,
      skillInvocation: { loaded: [], failed: [], receipts: [] },
      admittedAt: 10,
    },
  };
}
