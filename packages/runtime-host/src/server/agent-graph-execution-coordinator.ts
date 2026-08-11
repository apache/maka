import { randomUUID } from 'node:crypto';
import { normalizeMessageContent } from '@maka/core/events';
import { type UserMessageInput } from '@maka/core/runtime-inputs';
import { agentGraphIdForRootSession } from '@maka/runtime/stream-graph-coordinator';
import {
  recoverAgentGraphSupervisorContextOverflow,
  type AgentGraphSupervisorContextRecoveryDiagnostic,
  type AgentGraphSupervisorTurnOutcome,
} from '@maka/runtime/agent-graph-supervisor-wake';
import {
  RuntimeHostedRootConflictError,
  RuntimeMessageAuthorityInvariantError,
} from '@maka/runtime/message-authority';
import { type SessionManager } from '@maka/runtime/session-manager';
import type {
  HostedExecutionAdmission,
  HostedExecutionAdmissionResult,
  HostedExecutionAuthority,
  HostedExecutionSnapshot,
} from './hosted-execution-authority.js';
import {
  waitForHostedExecutionIdleOrAbort,
  waitForHostedExecutionTerminal,
} from './hosted-execution-wait.js';

type AgentGraphExecutionAuthority = Pick<
  HostedExecutionAuthority,
  'admit' | 'reconcile' | 'requestStop' | 'runExclusiveSessionOperation' | 'subscribe' | 'whenIdle'
>;
type AgentGraphRuntime = Pick<SessionManager, 'compactSession' | 'sendMessage'>;

export interface HostAgentGraphExecutionCoordinatorOptions {
  readonly executions: AgentGraphExecutionAuthority;
  readonly runtime: AgentGraphRuntime;
  readonly newId?: () => string;
}

/** Maps Agent Graph wake attempts onto the domain-neutral Hosted Execution port. */
export class HostAgentGraphExecutionCoordinator {
  readonly #executions: AgentGraphExecutionAuthority;
  readonly #runtime: AgentGraphRuntime;
  readonly #newId: () => string;

  constructor(options: HostAgentGraphExecutionCoordinatorOptions) {
    this.#executions = options.executions;
    this.#runtime = options.runtime;
    this.#newId = options.newId ?? randomUUID;
  }

  async run(
    sessionId: string,
    input: UserMessageInput,
    abortSignal: AbortSignal,
    isCurrent: () => Promise<boolean>,
  ): Promise<AgentGraphSupervisorTurnOutcome> {
    assertAgentGraphInput(sessionId, input);
    const origin = input.origin;
    if (origin?.kind !== 'agent_graph') {
      throw new RuntimeMessageAuthorityInvariantError('Agent Graph execution lost its origin');
    }
    const execution = {
      sessionId,
      turnId: input.turnId,
      runId: this.#newId(),
    };
    const userMessageId = this.#newId();
    let admitted: HostedExecutionAdmissionResult;
    for (;;) {
      throwIfAborted(abortSignal);
      if (!(await isCurrent())) return superseded(input.turnId);
      let gateCancelled = false;
      try {
        admitted = await this.#executions.admit({
          ...execution,
          userMessageId,
          execution: {
            kind: 'agent_graph_supervisor_wake',
            graphId: origin.graphId,
            wakeId: origin.wakeId,
            attemptId: origin.attemptId,
          },
          content: normalizeMessageContent(input),
          turnOrchestration: input.turnOrchestration,
          admitExecution: async () => {
            gateCancelled = !(await isCurrent());
            return gateCancelled ? 'cancelled' : 'executing';
          },
          start: ({ runId, userMessageId: admittedMessageId, onRunStarted }) => {
            if (runId !== execution.runId || admittedMessageId !== userMessageId) {
              throw new RuntimeMessageAuthorityInvariantError(
                'Hosted Execution changed the Agent Graph attempt identity',
              );
            }
            return this.#runtime.sendMessage(sessionId, input, {
              runId,
              userMessageId,
              durability: 'required',
              onRunStarted: async (startedRunId) => {
                if (startedRunId !== runId) {
                  throw new RuntimeMessageAuthorityInvariantError(
                    'Runtime changed the Agent Graph Run identity',
                  );
                }
                await onRunStarted();
              },
            });
          },
        } satisfies HostedExecutionAdmission);
        break;
      } catch (error) {
        if (gateCancelled) return superseded(input.turnId);
        if (!(error instanceof RuntimeHostedRootConflictError)) throw error;
        const whenIdle = this.#executions.whenIdle(sessionId);
        if (whenIdle) await waitForHostedExecutionIdleOrAbort(whenIdle, abortSignal);
      }
    }

    const terminal = await this.#waitForTerminal(execution, admitted, abortSignal);
    return classifyAgentGraphOutcome(terminal);
  }

  recoverContextOverflow(
    sessionId: string,
    compactTurnId: string,
    abortSignal: AbortSignal,
  ): Promise<AgentGraphSupervisorContextRecoveryDiagnostic | undefined> {
    return this.#executions.runExclusiveSessionOperation(
      { sessionId, abortSignal, stopSource: 'graph_supervisor' },
      () =>
        recoverAgentGraphSupervisorContextOverflow({
          rootSessionId: sessionId,
          compactTurnId,
          abortSignal,
          compactSession: (targetSessionId, input) =>
            this.#runtime.compactSession(targetSessionId, input),
        }),
    );
  }

  async #waitForTerminal(
    execution: {
      readonly sessionId: string;
      readonly turnId: string;
      readonly runId: string;
    },
    admitted: HostedExecutionAdmissionResult,
    abortSignal: AbortSignal,
  ): Promise<HostedExecutionSnapshot> {
    let stopTask: Promise<unknown> | undefined;
    const stop = (): void => {
      stopTask ??= this.#executions.requestStop({
        execution,
        source: 'graph_supervisor',
      });
      void stopTask.catch(() => undefined);
    };
    abortSignal.addEventListener('abort', stop, { once: true });
    if (abortSignal.aborted) stop();
    try {
      const terminal = await waitForHostedExecutionTerminal(
        this.#executions,
        execution,
        admitted.snapshot,
        { completion: admitted.completion },
      );
      await admitted.settled;
      return terminal;
    } finally {
      abortSignal.removeEventListener('abort', stop);
      await stopTask;
    }
  }
}

function assertAgentGraphInput(sessionId: string, input: UserMessageInput): void {
  if (
    input.origin?.kind !== 'agent_graph' ||
    input.origin.graphId !== agentGraphIdForRootSession(sessionId) ||
    input.turnOrchestration?.mode !== 'graph' ||
    input.turnOrchestration.source !== 'host_api'
  ) {
    throw new RuntimeMessageAuthorityInvariantError(
      'Agent Graph supervisor execution requires the Session graph origin and Host Graph orchestration',
    );
  }
}

function classifyAgentGraphOutcome(
  snapshot: HostedExecutionSnapshot,
): AgentGraphSupervisorTurnOutcome {
  if (snapshot.status === 'completed') return { kind: 'completed', turnId: snapshot.turnId };
  if (snapshot.status === 'cancelled') return { kind: 'aborted', turnId: snapshot.turnId };
  if (snapshot.status === 'failed') {
    if (
      snapshot.failureClass === 'context_overflow' ||
      snapshot.failureClass === 'context_budget_exhausted'
    ) {
      return {
        kind: 'context_overflow',
        turnId: snapshot.turnId,
        reason: snapshot.failureClass,
      };
    }
    return {
      kind: 'errored',
      turnId: snapshot.turnId,
      reason: `Turn ended with ${snapshot.failureClass}`,
    };
  }
  return {
    kind: 'errored',
    turnId: snapshot.turnId,
    reason: `Turn ended in non-terminal status ${snapshot.status}`,
  };
}

function superseded(turnId: string): AgentGraphSupervisorTurnOutcome {
  return {
    kind: 'superseded',
    turnId,
    reason: 'Agent graph supervisor checkpoint was superseded before root admission.',
  };
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new DOMException('Agent Graph supervisor execution was aborted', 'AbortError');
  }
}
