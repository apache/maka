import type { ToolResultContent } from '@maka/core/events';
import type { RuntimeEvent } from '@maka/core/runtime-event';
import type { ExecutionRuntimeEventWriter } from '@maka/storage/execution-stores';

const OUTCOME_UNKNOWN_TEXT =
  'outcome_unknown: the Host restarted after dispatching this Client Capability call. The client-side effect may have happened; do not retry it automatically.';

export async function recoverClientCapabilityOutcomes(
  store: ExecutionRuntimeEventWriter,
  sessionIds: readonly string[],
  now: () => number = Date.now,
): Promise<number> {
  let recovered = 0;
  for (const sessionId of sessionIds) {
    const operations = await store.listUnsettledToolOperations(sessionId);
    for (const operation of operations) {
      if (operation.recoveryMode !== 'outcome_unknown') continue;
      const ts = now();
      const result = {
        kind: 'text',
        text: OUTCOME_UNKNOWN_TEXT,
        uncertainOutcome: {
          code: 'outcome_unknown',
          retrySafe: false,
        },
      } as const satisfies ToolResultContent;
      const runtimeEvent: RuntimeEvent = {
        id: `${operation.operationId}_response`,
        invocationId: operation.invocationId,
        runId: operation.runId,
        sessionId,
        turnId: operation.turnId,
        ts,
        partial: false,
        role: 'tool',
        author: 'tool',
        content: {
          kind: 'function_response',
          id: operation.providerToolCallId,
          name: operation.toolName,
          result,
          isError: true,
        },
        refs: {
          operationId: operation.operationId,
          toolCallId: operation.providerToolCallId,
        },
      };
      const committed = await store.commitToolOutcome({
        operationId: operation.operationId,
        journalEventId: `${operation.operationId}_outcome`,
        runtimeEvent,
        committedAt: ts,
      });
      if (committed.created) recovered += 1;
    }
  }
  return recovered;
}
