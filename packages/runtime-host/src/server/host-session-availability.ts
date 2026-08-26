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

import type { RootExecutionDescriptor } from '@maka/core/agent-run';
import {
  isWorkHubCoordinationSession,
  isWorkHubCoordinationSessionId,
  isWorkHubCoordinationSessionTarget,
  type SessionHeader,
  type SessionToolProfile,
} from '@maka/core/session';

const WORKTREE_CHILD_UNAVAILABLE_REASON =
  'Worktree child Sessions must be continued through their parent agent.';
const CHILD_CONTINUATION_UNAVAILABLE_REASON =
  'Child Sessions must be continued through their parent agent.';
const IMPORT_STAGING_UNAVAILABLE_REASON = 'Imported Session history is still being prepared.';
export const WORKHUB_COORDINATION_EXECUTION_UNAVAILABLE_REASON =
  'WorkHub Coordination Session execution requires WorkHub authority';
export const WORKHUB_COORDINATION_TARGET_UNAVAILABLE_REASON =
  'WorkHub Coordination execution requires the reserved Coordination Session';

export function runtimeHostExternalTurnUnavailableReason(
  header: Pick<
    SessionHeader,
    'id' | 'role' | 'collaborationMode' | 'subagentWorkspace' | 'transcriptLedgerVersion'
  >,
): string | undefined {
  return runtimeHostExecutionUnavailableReason(header, { kind: 'external_message' });
}

export function runtimeHostSafeBoundaryContinuationUnavailableReason(
  header: Pick<SessionHeader, 'id' | 'role' | 'subagentParent' | 'transcriptLedgerVersion'>,
): string | undefined {
  return (
    (isWorkHubCoordinationSessionTarget(header)
      ? WORKHUB_COORDINATION_EXECUTION_UNAVAILABLE_REASON
      : undefined) ??
    (header.transcriptLedgerVersion === 0 ? IMPORT_STAGING_UNAVAILABLE_REASON : undefined) ??
    (header.subagentParent ? CHILD_CONTINUATION_UNAVAILABLE_REASON : undefined)
  );
}

export function runtimeHostExecutionUnavailableReason(
  header: Pick<
    SessionHeader,
    'id' | 'role' | 'collaborationMode' | 'subagentWorkspace' | 'transcriptLedgerVersion'
  > & {
    readonly toolProfile?: SessionToolProfile;
    readonly permissionMode?: SessionHeader['permissionMode'];
    readonly orchestrationMode?: SessionHeader['orchestrationMode'];
  },
  execution: RootExecutionDescriptor,
): string | undefined {
  const coordinationTarget = isWorkHubCoordinationSessionTarget(header);
  const coordinationIdentity =
    isWorkHubCoordinationSessionId(header.id) && isWorkHubCoordinationSession(header);
  return (
    (coordinationTarget && execution.kind !== 'workhub_coordination'
      ? WORKHUB_COORDINATION_EXECUTION_UNAVAILABLE_REASON
      : undefined) ??
    (execution.kind === 'workhub_coordination' && !coordinationIdentity
      ? WORKHUB_COORDINATION_TARGET_UNAVAILABLE_REASON
      : undefined) ??
    (execution.kind === 'workhub_coordination' && header.toolProfile !== 'workhub-coordination-v1'
      ? WORKHUB_COORDINATION_EXECUTION_UNAVAILABLE_REASON
      : undefined) ??
    (execution.kind === 'workhub_coordination' &&
    (header.permissionMode !== 'explore' ||
      (header.collaborationMode ?? 'agent') !== 'agent' ||
      (header.orchestrationMode ?? 'default') !== 'default')
      ? WORKHUB_COORDINATION_EXECUTION_UNAVAILABLE_REASON
      : undefined) ??
    (header.transcriptLedgerVersion === 0 ? IMPORT_STAGING_UNAVAILABLE_REASON : undefined) ??
    (header.collaborationMode === 'plan' &&
    execution.kind !== 'external_message' &&
    execution.kind !== 'regenerate' &&
    execution.kind !== 'context_compact' &&
    execution.kind !== 'safe_boundary_continuation'
      ? 'Background and delegated roots cannot execute while the Session is in Plan mode.'
      : undefined) ??
    (header.subagentWorkspace && !isManagedWorktreeChildExecution(execution)
      ? WORKTREE_CHILD_UNAVAILABLE_REASON
      : undefined)
  );
}

function isManagedWorktreeChildExecution(execution: RootExecutionDescriptor): boolean {
  return (
    execution.kind === 'linked_child_initial' ||
    execution.kind === 'linked_child_resume' ||
    execution.kind === 'linked_child_provider_retry' ||
    execution.kind === 'claimed_agent_graph_intent'
  );
}
