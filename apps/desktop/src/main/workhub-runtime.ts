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

import { WORKHUB_COORDINATION_SESSION_ID, type WorkHubCreateDefaults } from '@maka/core/session';
import type { WorkHubCoordinationProposal, WorkspaceTarget } from '@maka/runtime-host/protocol';
import { desktopSessionKey, type DesktopTargetScope } from '../shared/runtime-host-identity.js';
import type { WorkHubTasksInput } from '../shared/workhub-tool-schema.js';
import type { DesktopRuntimeHostClient } from './runtime-host-client.js';

interface WorkHubRuntimeDeps {
  client(scope: DesktopTargetScope): Pick<DesktopRuntimeHostClient, 'queryTurn' | 'stopTurn' | 'listWorkHubCoordinationCandidates' | 'actWorkHubCoordinationFromTurn'>;
  isCurrent(scope: DesktopTargetScope): boolean;
  createContext(scope: DesktopTargetScope): Promise<{ workspace: WorkspaceTarget; defaults: WorkHubCreateDefaults }>;
  changed(scope: DesktopTargetScope, reason: 'created' | 'status-change', sessionId: string): void;
}

/** Keep task authority in the Host; Desktop supplies only its selected workspace and preferences. */
export function createWorkHubRuntime(deps: WorkHubRuntimeDeps) {
  const requireCurrent = (scope: DesktopTargetScope) => {
    if (!deps.isCurrent(scope)) throw new Error('Runtime Host changed');
  };
  const queryTurn = async (client: ReturnType<WorkHubRuntimeDeps['client']>, turnId: string) => {
    const turn = await client.queryTurn({ sessionId: WORKHUB_COORDINATION_SESSION_ID, turnId });
    if (turn.sessionId !== WORKHUB_COORDINATION_SESSION_ID || turn.turnId !== turnId) throw new Error('WorkHub turn identity changed');
    return turn;
  };
  const isLive = (turn: Awaited<ReturnType<typeof queryTurn>>) =>
    turn.status !== 'completed' && turn.status !== 'failed' && turn.status !== 'cancelled';

  return {
    async assertTurn(scope: DesktopTargetScope, turnId: string): Promise<void> {
      requireCurrent(scope);
      const turn = await queryTurn(deps.client(scope), turnId);
      requireCurrent(scope);
      if (!isLive(turn)) throw new Error('WorkHub turn is no longer active');
    },
    async interrupt(scope: DesktopTargetScope, turnId: string): Promise<void> {
      const client = deps.client(scope);
      const turn = await queryTurn(client, turnId);
      if (isLive(turn)) await client.stopTurn({ sessionId: turn.sessionId, turnId: turn.turnId, runId: turn.runId });
    },
    async actTasks(scope: DesktopTargetScope, turnId: string, actionId: string, input: WorkHubTasksInput) {
      requireCurrent(scope);
      const client = deps.client(scope);
      if (input.operation === 'candidates') return client.listWorkHubCoordinationCandidates();
      let proposal: WorkHubCoordinationProposal;
      switch (input.operation) {
        case 'delegate_existing': proposal = { disposition: 'delegate_existing', candidateRef: input.candidateRef }; break;
        case 'create_new': proposal = { disposition: 'create_new', title: input.title }; break;
        case 'correct': proposal = { operation: 'correct', replacesActionId: input.replacesActionId, target: input.target }; break;
        case 'stop': proposal = { operation: 'stop', expects: { targetSessionId: input.targetSessionId } }; break;
        case 'resume': proposal = { operation: 'resume', resumesActionId: input.resumesActionId, expects: { targetSessionId: input.targetSessionId } }; break;
      }
      const createsTarget =
        ('disposition' in proposal && proposal.disposition === 'create_new') ||
        ('operation' in proposal &&
          proposal.operation === 'correct' &&
          proposal.target.disposition === 'create_new');
      const context = createsTarget ? await deps.createContext(scope) : undefined;
      requireCurrent(scope);
      const result = await client.actWorkHubCoordinationFromTurn({
        turnId, actionId, proposal,
        ...('text' in input ? { delegationText: input.text } : {}),
        ...('candidateSetId' in input && input.candidateSetId ? { candidateSetId: input.candidateSetId } : {}),
        ...(context ? { create: { workspace: context.workspace }, newWorkDefaults: context.defaults } : {}),
      });
      if (result.disposition === 'create_new' || (result.disposition === 'replace' && result.replacementDisposition === 'create_new')) {
        deps.changed(scope, 'created', result.targetSessionId);
      } else if (result.disposition === 'delegate_existing' || result.disposition === 'replace') {
        deps.changed(scope, 'status-change', result.targetSessionId);
      }
      return { ...result, actionId, ...('targetSessionId' in result ? { targetSessionKey: desktopSessionKey({ hostId: scope.hostId, sessionId: result.targetSessionId }) } : {}) };
    },
  };
}
