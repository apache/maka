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

import { useCallback, useEffect, useId, useRef, useState, type JSX } from 'react';
import type { PlanExecutionStep, PlanProposal, PlanSessionState } from '@maka/core/plan';
import type { SessionEvent } from '@maka/core/events';
import type { SessionSummary } from '@maka/core/session';
import { Banner } from '@astryxdesign/core/Banner';
import { Collapsible } from '@astryxdesign/core/Collapsible';
import { Badge, type BadgeVariant, Button as UiButton, useToast, useUiLocale, type UiLocale } from '@maka/ui';
import { reportUnexpectedError } from './application/contracts/operation-diagnostics.js';
import type { PlanControlIpcResult } from '../shared/plan-mode-ipc.js';
import {
  getPlanModeCopy,
  planControlFailureCopy,
  type PlanModeCopy,
} from './locales/plan-mode-copy.js';

export interface PlanModeState {
  state: PlanSessionState | undefined;
  pending: boolean;
  error: string | undefined;
  requestRevision(proposalId: string): Promise<void>;
  approve(proposal: PlanProposal): Promise<void>;
  resume(executionId: string): Promise<void>;
  abandon(executionId: string, title: string): Promise<void>;
}

/**
 * Identity of the panel instance a read or a user action belongs to.
 *
 * Switching Session installs a new object, so a late response can no longer
 * publish state, error or pending for the Session the user left — the read
 * sequence alone cannot do that, because an expired action resolving late would
 * otherwise claim the newest sequence for its own Session and overwrite the
 * panel the user is actually looking at. Within one object `sequence` supersedes
 * the reads started by an earlier effect run, so only the newest read of the
 * current Session wins.
 */
interface PlanPanelScope {
  readonly sessionId: string | undefined;
  sequence: number;
}

/**
 * The Plan control inputs a retry has to replay unchanged.
 *
 * The Host reconciles a retried control through its operation receipt, and the
 * receipt only matches while the recorded input — including the Turn the
 * operation was opened under — is unchanged. A retry therefore reuses this
 * record instead of re-deriving it from Plan state that has moved on, which is
 * exactly the case where the expected store version is stale by the time the
 * user retries.
 */
interface PlanApprovalRetry {
  sessionId: string;
  proposalId: string;
  expectedRevision: number;
  expectedStoreVersion: number;
  turnId: string;
}

interface PlanResumeRetry {
  sessionId: string;
  executionId: string;
  turnId: string;
}

/** One slot per Plan control, so the panel needs a single retry ref. */
interface PlanControlRetries {
  approval?: PlanApprovalRetry;
  resume?: PlanResumeRetry;
}

export function usePlanModeState(session: SessionSummary | undefined): PlanModeState {
  const toastApi = useToast();
  const locale = useUiLocale();
  const copy = getPlanModeCopy(locale);
  const [state, setState] = useState<PlanSessionState>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const retries = useRef<PlanControlRetries>({});

  // Session/lifecycle identity for this panel instance: a Session switch installs
  // a new scope, and the effect below supersedes the reads this scope started
  // when it is replaced. The switch is also the only thing that can strand the
  // pending indicator — the action that raised it owns the previous scope, so its
  // `finally` no longer clears this one — and clearing it here, while React is
  // already rendering the new Session, keeps that panel from rendering as busy.
  const scopeRef = useRef<PlanPanelScope>({ sessionId: session?.id, sequence: 0 });
  if (scopeRef.current.sessionId !== session?.id) {
    scopeRef.current = { sessionId: session?.id, sequence: 0 };
    setPending(false);
  }

  const refresh = useCallback(async () => {
    if (!session) return;
    const owner = scopeRef.current;
    // A read belongs to the Session this render was made for, and must not even
    // claim a sequence for a Session the panel has already left — that would
    // supersede the newer Session's own in-flight read.
    if (owner.sessionId !== session.id) return;
    // Plan execution writes now refresh while the Turn runs, so reads can
    // overlap: only the newest read may publish, or a slower earlier response
    // puts stale progress back on screen.
    const sequence = (owner.sequence += 1);
    let next: PlanSessionState;
    try {
      next = await window.maka.sessions.getPlanState(session.id);
    } catch (cause) {
      // A superseded read owns nothing, including its failure: report it only
      // while it is still the newest read of the Session still on screen.
      if (scopeRef.current !== owner || owner.sequence !== sequence) return;
      throw cause;
    }
    if (scopeRef.current !== owner || owner.sequence !== sequence) return;
    setState(next);
  }, [session?.id]);

  useEffect(() => {
    const scope = scopeRef.current;
    setState(undefined);
    setError(undefined);
    if (!session) return;
    const refreshOrReport = () => void refresh().catch((cause) => {
      reportUnexpectedError('plan-mode:refresh', cause);
      setError(copy.operationFailed);
    });
    refreshOrReport();
    const unsubscribeEvents = window.maka.sessions.subscribeEvents(session.id, (event: SessionEvent) => {
      if (
        event.type === 'plan_submitted'
        || event.type === 'complete'
        || event.type === 'abort'
      ) {
        refreshOrReport();
      }
    });
    const unsubscribePlanChanges = window.maka.sessions.subscribePlanChanges(
      session.id,
      refreshOrReport,
    );
    return () => {
      // Supersedes every read this run started: a Session switch, a close and an
      // unmount all pass through here, and the next effect refreshes again.
      scope.sequence += 1;
      unsubscribeEvents();
      unsubscribePlanChanges();
    };
  }, [copy.operationFailed, session?.id, session?.collaborationMode, refresh]);

  const run = useCallback(
    async (
      owner: PlanPanelScope,
      action: () => Promise<PlanControlIpcResult<unknown>>,
    ): Promise<void> => {
      // Callers capture their scope before their first await — for `abandon`
      // that is before the confirmation dialog — so an action that resumes after
      // a Session switch never adopts the Session that replaced it. The
      // confirmation belonged to a panel the user has left, and the panel that
      // replaced it belongs to a Session nobody confirmed anything for, so the
      // action is dropped instead of applied.
      if (owner.sessionId === undefined || scopeRef.current !== owner) return;
      setPending(true);
      setError(undefined);
      try {
        const result = await action();
        if (scopeRef.current !== owner) return;
        if (!result.ok) {
          setError(planControlFailureCopy(result.error, copy));
          return;
        }
        await refresh();
      } catch (cause) {
        if (scopeRef.current !== owner) return;
        reportUnexpectedError('plan-mode:action', cause);
        setError(copy.operationFailed);
      } finally {
        if (scopeRef.current === owner) setPending(false);
      }
    },
    [copy, refresh],
  );

  const requestRevision = useCallback(async (proposalId: string): Promise<void> => {
    if (!session) return;
    const owner = scopeRef.current;
    await run(owner, async () => {
      return window.maka.sessions.requestPlanRevision(session.id, proposalId);
    });
  }, [run, session?.id]);

  const approve = useCallback(async (proposal: PlanProposal): Promise<void> => {
    if (!session || !state) return;
    const owner = scopeRef.current;
    const current = retries.current.approval;
    const input =
      current
      && current.sessionId === session.id
      && current.proposalId === proposal.proposalId
      && current.expectedRevision === proposal.revision
        ? current
        : {
            sessionId: session.id,
            proposalId: proposal.proposalId,
            expectedRevision: proposal.revision,
            expectedStoreVersion: state.storeVersion,
            turnId: crypto.randomUUID(),
          };
    retries.current.approval = input;
    await run(owner, async () => {
      const result = await window.maka.sessions.approvePlan(session.id, {
        proposalId: input.proposalId,
        expectedRevision: input.expectedRevision,
        expectedStoreVersion: input.expectedStoreVersion,
        turnId: input.turnId,
      });
      // Only the request that stored this input may retire it: a response that
      // arrives after a newer request replaced the slot has to leave it alone, or
      // the newer retry loses the Turn id its receipt is keyed by and the Host
      // sees a second approval instead of a replay.
      if (result.ok && retries.current.approval === input) retries.current.approval = undefined;
      return result;
    });
  }, [run, session?.id, state]);

  const resume = useCallback(async (executionId: string): Promise<void> => {
    if (!session) return;
    const owner = scopeRef.current;
    const current = retries.current.resume;
    const input =
      current && current.sessionId === session.id && current.executionId === executionId
        ? current
        : { sessionId: session.id, executionId, turnId: crypto.randomUUID() };
    retries.current.resume = input;
    await run(owner, async () => {
      const result = await window.maka.sessions.resumePlan(session.id, executionId, input.turnId);
      if (result.ok && retries.current.resume === input) retries.current.resume = undefined;
      return result;
    });
  }, [run, session?.id]);

  const abandon = useCallback(async (executionId: string, title: string): Promise<void> => {
    if (!session) return;
    // Captured before the confirmation: the dialog stays open across a Session
    // switch, and confirming it afterwards must not apply the abandon to the
    // Session that replaced the one the user was looking at.
    const owner = scopeRef.current;
    const confirmed = await toastApi.confirm({
      title: copy.abandonConfirmation.title,
      description: copy.abandonConfirmation.description(title),
      confirmLabel: copy.abandonConfirmation.confirm,
      cancelLabel: copy.abandonConfirmation.cancel,
      destructive: true,
    });
    if (!confirmed) return;
    await run(owner, async () => {
      return window.maka.sessions.abandonPlanExecution(session.id, executionId);
    });
  }, [copy, run, session?.id, toastApi]);

  return { state, pending, error, requestRevision, approve, resume, abandon };
}

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
