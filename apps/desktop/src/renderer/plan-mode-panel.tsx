import { useCallback, useEffect, useId, useRef, useState, type JSX } from 'react';
import type { PlanExecutionStep, PlanProposal, PlanSessionState } from '@maka/core/plan';
import type { SessionEvent } from '@maka/core/events';
import type { SessionSummary } from '@maka/core/session';
import { Banner } from '@astryxdesign/core/Banner';
import { Collapsible } from '@astryxdesign/core/Collapsible';
import { Badge, type BadgeVariant, Button as UiButton, useToast } from '@maka/ui';

export interface PlanModeState {
  state: PlanSessionState | undefined;
  pending: boolean;
  error: string | undefined;
  requestRevision(proposalId: string): Promise<void>;
  approve(proposal: PlanProposal): Promise<void>;
  resume(executionId: string): Promise<void>;
  abandon(executionId: string, title: string): Promise<void>;
}

export function usePlanModeState(session: SessionSummary | undefined): PlanModeState {
  const toastApi = useToast();
  const [state, setState] = useState<PlanSessionState>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const approvalRetry = useRef<{
    sessionId: string;
    proposalId: string;
    expectedRevision: number;
    expectedStoreVersion: number;
    turnId: string;
  } | undefined>(undefined);
  const resumeRetry = useRef<{
    sessionId: string;
    executionId: string;
    turnId: string;
  } | undefined>(undefined);

  const refresh = useCallback(async () => {
    if (!session) return;
    setState(await window.maka.sessions.getPlanState(session.id));
  }, [session?.id]);

  useEffect(() => {
    setState(undefined);
    setError(undefined);
    if (!session) return;
    const refreshOrReport = () => void refresh().catch((cause) => setError(message(cause)));
    refreshOrReport();
    const unsubscribeEvents = window.maka.sessions.subscribeEvents(session.id, (event: SessionEvent) => {
      if (
        event.type === 'plan_submitted'
        || event.type === 'complete'
        || event.type === 'abort'
        || isPlanToolResult(event)
      ) {
        refreshOrReport();
      }
    });
    const unsubscribePlanChanges = window.maka.sessions.subscribePlanChanges(
      session.id,
      refreshOrReport,
    );
    return () => {
      unsubscribeEvents();
      unsubscribePlanChanges();
    };
  }, [session?.id, session?.collaborationMode, refresh]);

  const run = useCallback(async (action: () => Promise<void>): Promise<void> => {
    setPending(true);
    setError(undefined);
    try {
      await action();
      await refresh();
    } catch (cause) {
      setError(message(cause));
    } finally {
      setPending(false);
    }
  }, [refresh]);

  const requestRevision = useCallback(async (proposalId: string): Promise<void> => {
    if (!session) return;
    await run(async () => {
      await window.maka.sessions.requestPlanRevision(session.id, proposalId);
    });
  }, [run, session?.id]);

  const approve = useCallback(async (proposal: PlanProposal): Promise<void> => {
    if (!session || !state) return;
    const current = approvalRetry.current;
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
    approvalRetry.current = input;
    await run(async () => {
      await window.maka.sessions.approvePlan(session.id, {
        proposalId: input.proposalId,
        expectedRevision: input.expectedRevision,
        expectedStoreVersion: input.expectedStoreVersion,
        turnId: input.turnId,
      });
      approvalRetry.current = undefined;
    });
  }, [run, session?.id, state]);

  const resume = useCallback(async (executionId: string): Promise<void> => {
    if (!session) return;
    const current = resumeRetry.current;
    const input =
      current && current.sessionId === session.id && current.executionId === executionId
        ? current
        : { sessionId: session.id, executionId, turnId: crypto.randomUUID() };
    resumeRetry.current = input;
    await run(async () => {
      await window.maka.sessions.resumePlan(session.id, executionId, input.turnId);
      resumeRetry.current = undefined;
    });
  }, [run, session?.id]);

  const abandon = useCallback(async (executionId: string, title: string): Promise<void> => {
    if (!session) return;
    const confirmed = await toastApi.confirm({
      title: '放弃这个计划？',
      description: `“${title}”的执行记录会保留，但之后不能继续恢复。`,
      confirmLabel: '放弃计划',
      cancelLabel: '取消',
      destructive: true,
    });
    if (!confirmed) return;
    await run(async () => {
      await window.maka.sessions.abandonPlanExecution(session.id, executionId);
    });
  }, [run, session?.id, toastApi]);

  return { state, pending, error, requestRevision, approve, resume, abandon };
}

export function PlanProposalCard(props: {
  proposal: PlanProposal;
  planMode: PlanModeState;
}): JSX.Element {
  const { proposal, planMode } = props;
  const reviewable =
    proposal.status === 'pending_approval'
    && planMode.state?.latestProposalId === proposal.proposalId;

  return (
    <section className="plan-mode-panel" aria-label="计划方案">
      <div className="plan-proposal-card" data-status={proposal.status}>
        <div className="plan-proposal-heading">
          <div className="plan-proposal-title">
            <span className="plan-proposal-kicker">计划方案</span>
            <strong>{proposal.title}</strong>
          </div>
          <div className="plan-proposal-meta">
            <Badge
              className="plan-proposal-revision"
              label={
                <>
                  Revision <code>{proposal.revision}</code>
                </>
              }
            />
            <Badge
              variant={proposalStatusVariant(proposal.status)}
              label={proposalStatusLabel(proposal.status)}
            />
          </div>
        </div>
        {proposal.overview && <p className="plan-proposal-overview">{proposal.overview}</p>}
        <div className="plan-proposal-section">
          <h3>执行步骤</h3>
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
            <h3>风险</h3>
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
              label="继续修改"
            />
            <UiButton
              variant="primary"
              size="sm"
              isDisabled={planMode.pending}
              onClick={() => void planMode.approve(proposal)}
              label="执行计划"
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
    <section className="plan-execution-panel" aria-label="计划执行状态">
      <Collapsible
        className="plan-execution-toggle"
        isOpen={expanded}
        onOpenChange={setExpanded}
        trigger={(
          <div className="plan-execution-trigger-body">
            <div>
              <span>{execution.status === 'interrupted' ? '计划已中断' : '正在执行计划'}</span>
              <strong>{proposal?.title ?? '已批准计划'}</strong>
            </div>
            <span className="plan-execution-summary">
              <span className="plan-execution-count">{completedCount}/{execution.steps.length} 步</span>
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
                  aria-label={executionStepStatusLabel(step.status)}
                  title={executionStepStatusLabel(step.status)}
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
                label="恢复执行"
              />
              <UiButton
                variant="destructive"
                size="sm"
                isDisabled={planMode.pending}
                onClick={() => void planMode.abandon(
                  execution.executionId,
                  proposal?.title ?? '已批准计划',
                )}
                label="放弃计划"
              />
            </div>
          )}
        </div>
      </Collapsible>
      {planMode.error && <Banner status="error" role="alert" title={planMode.error} />}
    </section>
  );
}

function isPlanToolResult(event: SessionEvent): boolean {
  if (event.type !== 'tool_result' || event.content.kind !== 'json') return false;
  const value = event.content.value;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const kind = (value as { kind?: unknown }).kind;
  return kind === 'plan_progress_updated'
    || kind === 'plan_execution_completed'
    || kind === 'plan_execution_cancelled';
}

function proposalStatusLabel(status: PlanProposal['status']): string {
  if (status === 'approved') return '已批准';
  if (status === 'stale') return '已过期';
  return '等待确认';
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

function executionStepStatusLabel(status: PlanExecutionStep['status']): string {
  if (status === 'completed') return '已完成';
  if (status === 'in_progress') return '正在执行';
  if (status === 'skipped') return '已跳过';
  return '未开始';
}

function executionStepMark(status: PlanExecutionStep['status']): string {
  if (status === 'completed') return '✓';
  if (status === 'in_progress') return '•';
  if (status === 'skipped') return '–';
  return '';
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
