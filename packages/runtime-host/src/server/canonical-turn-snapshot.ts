import type { AgentRunHeader } from '@maka/core/agent-run';
import { truncateUtf8 } from '@maka/core/diagnostic-log';
import { redactSecrets } from '@maka/core/redaction';
import { classifyTerminalRuntimeLedger } from '@maka/runtime/terminal-run-commit';
import type { ExecutionStoresWriter } from '@maka/storage/execution-stores';
import { TURN_FAILURE_MESSAGE_MAX_BYTES, type TurnSnapshot } from '../protocol/index.js';

type CanonicalTurnStores = Pick<
  ExecutionStoresWriter<'interactive'>,
  'agentRunStore' | 'runtimeEventStore'
>;

export interface CanonicalTurnIdentity {
  readonly sessionId: string;
  readonly turnId: string;
  readonly runId: string;
}

export async function readCanonicalTurnSnapshot(
  stores: CanonicalTurnStores,
  identity: CanonicalTurnIdentity,
  knownRun?: AgentRunHeader,
): Promise<TurnSnapshot> {
  const { sessionId, turnId, runId } = identity;
  const run = knownRun ?? (await readRunIfPresent(stores, sessionId, runId));
  if (!run) return { sessionId, turnId, runId, status: 'admitted' };
  if (run.turnId !== turnId) {
    throw new Error('Admitted Turn identity does not match its Run header');
  }

  const [runEvents, runtimeEvents] = await Promise.all([
    stores.agentRunStore.readEvents(sessionId, runId),
    stores.runtimeEventStore.readImmutableRuntimeEvents(sessionId, runId),
  ]);
  const terminal = classifyTerminalRuntimeLedger(run, runtimeEvents);
  if (terminal.kind === 'fact') {
    const fact = terminal.fact;
    if (fact.runStatus === 'completed') {
      return {
        sessionId,
        turnId,
        runId,
        status: 'completed',
        terminalEventId: fact.terminalEvent.id,
      };
    }
    if (fact.runStatus === 'failed') {
      if (!fact.failureClass) throw new Error('Failed terminal fact has no failure class');
      const failureMessage =
        fact.terminalEvent.content?.kind === 'error'
          ? truncateUtf8(
              redactSecrets(fact.terminalEvent.content.message),
              TURN_FAILURE_MESSAGE_MAX_BYTES,
              '…',
            )
          : undefined;
      return {
        sessionId,
        turnId,
        runId,
        status: 'failed',
        terminalEventId: fact.terminalEvent.id,
        failureClass: fact.failureClass,
        ...(failureMessage ? { failureMessage } : {}),
      };
    }
    if (!fact.abortSource) throw new Error('Cancelled terminal fact has no abort source');
    return {
      sessionId,
      turnId,
      runId,
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
  return { sessionId, turnId, runId, status: run.status };
}

/** Maximizes the encoded size of a protocol-valid failed Turn snapshot. */
export function worstCaseFailedTurnSnapshot(identity: CanonicalTurnIdentity): TurnSnapshot {
  return {
    ...identity,
    status: 'failed',
    terminalEventId: 'x'.repeat(128),
    failureClass: '\0'.repeat(128),
    failureMessage: '\0'.repeat(TURN_FAILURE_MESSAGE_MAX_BYTES),
  };
}

async function readRunIfPresent(
  stores: CanonicalTurnStores,
  sessionId: string,
  runId: string,
): Promise<AgentRunHeader | undefined> {
  try {
    return await stores.agentRunStore.readRun(sessionId, runId);
  } catch (error) {
    if (isMissingFile(error)) return undefined;
    throw error;
  }
}

export function isMissingFile(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}
