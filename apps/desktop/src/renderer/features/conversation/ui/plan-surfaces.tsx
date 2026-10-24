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

import type { ComponentProps } from 'react';
import { ChatView } from '@maka/ui';
import { usePlanState } from './plan-context.js';
import { PlanExecutionPanel, PlanProposalCard } from './plan-panels.js';

/** Proposal projection stays at the transcript reader, never in AppShell. */
export function PlanChatView(props: Omit<ComponentProps<typeof ChatView>, 'conversationItems'>) {
  const plan = usePlanState();
  const conversationItems = (plan.state?.proposals ?? []).map((proposal) => ({
    id: proposal.proposalId,
    afterTurnId: proposal.turnId,
    renderWhenAnchorMissing: proposal.status === 'pending_approval'
      && proposal.proposalId === plan.state?.latestProposalId,
    content: <PlanProposalCard proposal={proposal} planMode={plan} />,
  }));
  return <ChatView {...props} conversationItems={conversationItems} />;
}

export function PlanExecutionSurface() {
  const plan = usePlanState();
  return <PlanExecutionPanel planMode={plan} />;
}
