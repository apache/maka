import {
  agentRunMatchesHostedRootExecution,
  type AgentRunHeader,
  type RootExecutionDescriptor,
} from '@maka/core/agent-run';
import { RuntimeMessageAuthorityInvariantError } from '@maka/runtime/message-authority';
import type { ExecutionStoresWriter } from '@maka/storage/execution-stores';
import { readCanonicalTurnSnapshot } from './canonical-turn-snapshot.js';
import type { HostedExecutionRef, HostedExecutionSnapshot } from './hosted-execution-authority.js';

export class HostedExecutionProjectionReader {
  constructor(private readonly stores: ExecutionStoresWriter<'interactive'>) {}

  async read(
    execution: HostedExecutionRef,
    knownRun?: AgentRunHeader,
  ): Promise<HostedExecutionSnapshot> {
    const run = knownRun ?? (await this.readRunIfPresent(execution.sessionId, execution.runId));
    if (run && run.turnId !== execution.turnId) {
      throw new RuntimeMessageAuthorityInvariantError(
        `Hosted execution ${execution.turnId} does not match Run ${execution.runId}`,
      );
    }
    return readCanonicalTurnSnapshot(this.stores, execution, run);
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
    case 'scheduled_task':
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
        | 'scheduled_task'
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
