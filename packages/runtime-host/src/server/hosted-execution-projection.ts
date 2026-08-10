import {
  agentRunMatchesHostedRootExecution,
  type AgentRunHeader,
  type RootExecutionDescriptor,
} from '@maka/core/agent-run';
import {
  classifyTerminalRuntimeLedger,
  RuntimeMessageAuthorityInvariantError,
} from '@maka/runtime';
import type { ExecutionStoresWriter } from '@maka/storage/execution-stores';
import type { HostedExecutionRef, HostedExecutionSnapshot } from './hosted-execution-authority.js';

export class HostedExecutionProjectionReader {
  constructor(private readonly stores: ExecutionStoresWriter<'interactive'>) {}

  async read(
    execution: HostedExecutionRef,
    knownRun?: AgentRunHeader,
  ): Promise<HostedExecutionSnapshot> {
    const run = knownRun ?? (await this.readRunIfPresent(execution.sessionId, execution.runId));
    if (!run) return { ...execution, status: 'admitted' };
    if (run.turnId !== execution.turnId) {
      throw new RuntimeMessageAuthorityInvariantError(
        `Hosted execution ${execution.turnId} does not match Run ${execution.runId}`,
      );
    }

    const [runEvents, runtimeEvents] = await Promise.all([
      this.stores.agentRunStore.readEvents(execution.sessionId, execution.runId),
      this.stores.runtimeEventStore.readImmutableRuntimeEvents(
        execution.sessionId,
        execution.runId,
      ),
    ]);
    const terminal = classifyTerminalRuntimeLedger(run, runtimeEvents);
    if (terminal.kind === 'fact') {
      const fact = terminal.fact;
      if (fact.runStatus === 'completed') {
        return {
          ...execution,
          status: 'completed',
          terminalEventId: fact.terminalEvent.id,
        };
      }
      if (fact.runStatus === 'failed') {
        if (!fact.failureClass) throw new Error('Failed terminal fact has no failure class');
        return {
          ...execution,
          status: 'failed',
          terminalEventId: fact.terminalEvent.id,
          failureClass: fact.failureClass,
        };
      }
      if (!fact.abortSource) throw new Error('Cancelled terminal fact has no abort source');
      return {
        ...execution,
        status: 'cancelled',
        terminalEventId: fact.terminalEvent.id,
        abortSource: fact.abortSource,
      };
    }
    if (terminal.kind !== 'none') {
      throw new Error('Runtime ledger does not contain one canonical terminal fact');
    }
    if (run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled') {
      throw new Error('Terminal Run header has no canonical terminal RuntimeEvent');
    }
    if (run.status !== 'created' && !runEvents.some((event) => event.type === 'run_started')) {
      throw new Error('Non-created Run has no durable start fact');
    }
    return { ...execution, status: run.status };
  }

  async readRunIfPresent(sessionId: string, runId: string): Promise<AgentRunHeader | undefined> {
    try {
      return await this.stores.agentRunStore.readRun(sessionId, runId);
    } catch (error) {
      if (isMissingFile(error)) return undefined;
      throw error;
    }
  }

  assertRunIdentity(run: AgentRunHeader, turnId: string, execution: RootExecutionDescriptor): void {
    assertRunMatchesExecution(run, turnId, execution);
  }

  async assertRunIdentityAndContinuation(
    run: AgentRunHeader,
    turnId: string,
    execution: RootExecutionDescriptor,
  ): Promise<void> {
    assertRunMatchesExecution(run, turnId, execution);
    if (execution.kind !== 'safe_boundary_continuation') return;
    const first = (
      await this.stores.runtimeEventStore.readImmutableRuntimeEvents(run.sessionId, run.runId)
    )[0];
    const start = first?.actions?.continuationStart;
    if (
      first?.invocationId !== execution.targetInvocationId ||
      first.turnId !== turnId ||
      !start ||
      start.claimId !== execution.claimId ||
      start.boundaryDigest !== execution.boundaryDigest ||
      start.replayManifestDigest !== execution.boundaryDigest ||
      start.providerReplayDigest !== execution.providerReplayDigest ||
      start.immediateSource.sessionId !== run.sessionId ||
      start.immediateSource.invocationId !== execution.sourceInvocationId ||
      start.immediateSource.runId !== execution.sourceRunId ||
      start.immediateSource.turnId !== execution.sourceTurnId ||
      start.immediateSource.highWater !== execution.sourceRuntimeEventHighWater
    ) {
      throw new RuntimeMessageAuthorityInvariantError(
        `Admitted Turn ${turnId} changed its continuation start proof`,
      );
    }
  }
}

function assertRunMatchesExecution(
  run: AgentRunHeader,
  turnId: string,
  execution: RootExecutionDescriptor,
): void {
  if (run.turnId !== turnId) {
    throw new RuntimeMessageAuthorityInvariantError(
      `Admitted Turn ${turnId} does not match Run ${run.runId}`,
    );
  }
  switch (execution.kind) {
    case 'external_message':
      return;
    case 'regenerate':
    case 'context_compact':
    case 'automation':
    case 'goal':
    case 'agent_graph_supervisor_wake':
    case 'safe_boundary_continuation':
      if (agentRunMatchesHostedRootExecution(run, execution)) return;
      break;
    case 'linked_child_initial':
    case 'claimed_agent_graph_intent':
      assertTrustedAgentIdentity(run, turnId, execution);
      if (run.resumedFromRunId === undefined && run.retriedFromRunId === undefined) return;
      break;
    case 'linked_child_resume':
      assertTrustedAgentIdentity(run, turnId, execution);
      if (run.resumedFromRunId === execution.sourceRunId && run.retriedFromRunId === undefined) {
        return;
      }
      break;
    case 'linked_child_provider_retry':
      assertTrustedAgentIdentity(run, turnId, execution);
      if (run.retriedFromRunId === execution.sourceRunId && run.resumedFromRunId === undefined) {
        return;
      }
      break;
    default:
      assertNever(execution);
  }
  throw new RuntimeMessageAuthorityInvariantError(
    `Admitted Turn ${turnId} changed its root execution identity`,
  );
}

function assertTrustedAgentIdentity(
  run: AgentRunHeader,
  turnId: string,
  execution: Exclude<
    RootExecutionDescriptor,
    {
      kind:
        | 'external_message'
        | 'regenerate'
        | 'context_compact'
        | 'automation'
        | 'goal'
        | 'agent_graph_supervisor_wake'
        | 'safe_boundary_continuation';
    }
  >,
): void {
  if (run.agentId !== execution.agentId || run.agentName !== execution.agentName) {
    throw new RuntimeMessageAuthorityInvariantError(
      `Admitted Turn ${turnId} changed its trusted agent identity`,
    );
  }
}

function isMissingFile(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

function assertNever(value: never): never {
  throw new Error(`Unexpected execution descriptor: ${String(value)}`);
}
