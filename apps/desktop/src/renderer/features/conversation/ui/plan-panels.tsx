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

import { useEffect, useId, useState, type JSX } from 'react';
import type { PlanExecutionStep, PlanProposal } from '@maka/core/plan';
import { Banner } from '@astryxdesign/core/Banner';
import { Collapsible } from '@astryxdesign/core/Collapsible';
import { Badge, type BadgeVariant, Button as UiButton, useUiLocale } from '@maka/ui';
import { getPlanModeCopy, type PlanModeCopy } from '../../../locales/plan-mode-copy.js';
import type { PlanModeState } from '../model/plan-state.js';

export function PlanProposalCard(props: {
  proposal: PlanProposal;
  planMode: PlanModeState;
}): JSX.Element {
  const { proposal, planMode } = props;
  const copy = getPlanModeCopy(useUiLocale()).proposal;
  const reviewable =
    proposal.status === 'pending_approval'
    && planMode.state?.latestProposalId === proposal.proposalId;

  return (
    <section className="plan-mode-panel" aria-label={copy.aria}>
      <div className="plan-proposal-card" data-status={proposal.status}>
        <div className="plan-proposal-heading">
          <div className="plan-proposal-title">
            <span className="plan-proposal-kicker">{copy.kicker}</span>
            <strong>{proposal.title}</strong>
          </div>
          <div className="plan-proposal-meta">
            <Badge
              className="plan-proposal-revision"
              label={
                <>
                  {copy.revision} <code>{proposal.revision}</code>
                </>
              }
            />
            <Badge
              variant={proposalStatusVariant(proposal.status)}
              label={proposalStatusLabel(proposal.status, copy)}
            />
          </div>
        </div>
        {proposal.overview && <p className="plan-proposal-overview">{proposal.overview}</p>}
        <div className="plan-proposal-section">
          <h3>{copy.steps}</h3>
          <ol className="plan-proposal-steps">
            {proposal.steps.map((step, index) => (
              <li key={step.id}>
                <span className="plan-proposal-step-number" aria-hidden="true">{index + 1}</span>
                <div className="plan-proposal-step-content">
                  <strong>{step.title}</strong>
                  <p>{step.description}</p>
                </div>
              </li>
            ))}
          </ol>
        </div>
        {proposal.risks && proposal.risks.length > 0 && (
          <div className="plan-proposal-section plan-proposal-risks">
            <h3>{copy.risks}</h3>
            <ul>
              {proposal.risks.map((risk, index) => <li key={`${index}:${risk}`}>{risk}</li>)}
            </ul>
          </div>
        )}
        {reviewable && (
          <div className="plan-proposal-actions">
            <UiButton
              variant="secondary"
              size="sm"
              isDisabled={planMode.pending}
              onClick={() => void planMode.requestRevision(proposal.proposalId)}
              label={copy.revise}
            />
            <UiButton
              variant="primary"
              size="sm"
              isDisabled={planMode.pending}
              onClick={() => void planMode.approve(proposal)}
              label={copy.execute}
            />
          </div>
        )}
        {planMode.error && reviewable && (
          <Banner status="error" role="alert" title={planMode.error} />
        )}
      </div>
    </section>
  );
}

export function PlanExecutionPanel(props: {
  planMode: PlanModeState;
}): JSX.Element | null {
  const { planMode } = props;
  const copy = getPlanModeCopy(useUiLocale()).execution;
  const [expanded, setExpanded] = useState(false);
  const detailsId = useId();
  const active = planMode.state?.executions.find(
    (item) => item.executionId === planMode.state?.activeExecutionId,
  );
  const interrupted = [...(planMode.state?.executions ?? [])].reverse().find(
    (item) => item.status === 'interrupted',
  );
  const execution = active ?? interrupted;
  useEffect(() => {
    setExpanded(false);
  }, [execution?.executionId]);
  if (!execution) return null;

  const proposal = planMode.state?.proposals.find(
    (item) => item.proposalId === execution.proposalId,
  );
  const completedCount = execution.steps.filter(
    (step) => step.status === 'completed' || step.status === 'skipped',
  ).length;

  return (
    <section className="plan-execution-panel" aria-label={copy.aria}>
      <Collapsible
        className="plan-execution-toggle"
        isOpen={expanded}
        onOpenChange={setExpanded}
        trigger={(
          <div className="plan-execution-trigger-body">
            <div>
              <span>{execution.status === 'interrupted' ? copy.interrupted : copy.running}</span>
              <strong>{proposal?.title ?? copy.approvedPlan}</strong>
            </div>
            <span className="plan-execution-summary">
              <span className="plan-execution-count">{copy.stepCount(completedCount, execution.steps.length)}</span>
            </span>
          </div>
        )}
      >
        <div className="plan-execution-details" id={detailsId}>
          <ol className="plan-execution-steps">
            {execution.steps.map((step) => (
              <li key={step.id} data-status={step.status}>
                <span
                  className="plan-execution-step-marker"
                  data-status={step.status}
                  role="img"
                  aria-label={executionStepStatusLabel(step.status, copy)}
                  title={executionStepStatusLabel(step.status, copy)}
                >
                  {executionStepMark(step.status)}
                </span>
                <span>{step.title}</span>
              </li>
            ))}
          </ol>
          {execution.status === 'interrupted' && (
            <div className="plan-execution-actions">
              <UiButton
                variant="secondary"
                size="sm"
                isDisabled={planMode.pending}
                onClick={() => void planMode.resume(execution.executionId)}
                label={copy.resume}
              />
              <UiButton
                variant="destructive"
                size="sm"
                isDisabled={planMode.pending}
                onClick={() => void planMode.abandon(
                  execution.executionId,
                  proposal?.title ?? copy.approvedPlan,
                )}
                label={copy.abandon}
              />
            </div>
          )}
        </div>
      </Collapsible>
      {planMode.error && <Banner status="error" role="alert" title={planMode.error} />}
    </section>
  );
}

function proposalStatusLabel(
  status: PlanProposal['status'],
  copy: PlanModeCopy['proposal'],
): string {
  return copy.statuses[status];
}

/* #1879: the status pill is an Astryx `Badge`. Only `approved` is a semantic
   outcome; waiting and stale are steady states, so they stay neutral rather
   than borrowing a colour the state does not mean. `green` rather than
   `success` because Astryx paints its semantic archive as solid saturated
   fills and its colour archive as tints — the chrome this replaced was a
   tint. */
function proposalStatusVariant(status: PlanProposal['status']): BadgeVariant {
  return status === 'approved' ? 'green' : 'neutral';
}

function executionStepStatusLabel(
  status: PlanExecutionStep['status'],
  copy: PlanModeCopy['execution'],
): string {
  return copy.stepStatuses[status];
}

function executionStepMark(status: PlanExecutionStep['status']): string {
  if (status === 'completed') return '✓';
  if (status === 'in_progress') return '•';
  if (status === 'skipped') return '–';
  return '';
}
