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

import type { SessionSettingsServices } from '../ports.js';
import type { SessionSettingsInput } from './session-settings-contract.js';

/** Read the Host authority before changing Plan; never retarget after an await. */
export async function writeSessionPlanMode(
  services: Pick<SessionSettingsServices, 'getPlanState' | 'abandonPlanProposal' | 'setCollaborationMode'>,
  presentation: SessionSettingsInput<{ sessionId?: string }>['planMode'],
  sessionId: string,
  active: boolean,
): Promise<boolean> {
  const state = await services.getPlanState(sessionId);
  if (active && state.activeExecutionId) {
    presentation.reportExecutionActive(sessionId);
    return false;
  }
  const proposal = state.proposals.find((item) => item.proposalId === state.latestProposalId);
  if (!active && proposal?.status === 'pending_approval') {
    if (!(await presentation.confirmDiscard(proposal.title))) return false;
    // Abandoning the proposal also leaves Plan in the Runtime authority.
    await services.abandonPlanProposal(sessionId, proposal.proposalId);
  } else {
    await services.setCollaborationMode(sessionId, active ? 'plan' : 'agent');
  }
  return true;
}
