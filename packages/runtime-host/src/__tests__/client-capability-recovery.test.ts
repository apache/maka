import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  TOOL_BOUNDARY_PROTOCOL_V1,
  type RuntimeEvent,
  type ToolRecoveryMode,
} from '@maka/core/runtime-event';
import { canonicalToolArgsHash } from '@maka/core/tool-args-identity';
import { createSqliteRuntimeStore } from '@maka/storage';
import { recoverClientCapabilityOutcomes } from '../server/client-capability-recovery.js';

test('successor recovery durably settles dispatched Client Capabilities as outcome_unknown', async () => {
  const store = createSqliteRuntimeStore(':memory:');
  try {
    await prepare(store, 'capability-operation', 'outcome_unknown');
    await prepare(store, 'ordinary-operation', 'never_auto_retry');
    await prepare(store, 'other-session-operation', 'outcome_unknown', 'session-2');

    assert.equal(await recoverClientCapabilityOutcomes(store, ['session-1'], () => 50), 1);
    const recovered = await store.readRuntimeEvents('session-1', 'capability-operation-run');
    assert.deepEqual(recovered.at(-1), {
      id: 'capability-operation_response',
      invocationId: 'capability-operation-invocation',
      runId: 'capability-operation-run',
      sessionId: 'session-1',
      turnId: 'capability-operation-turn',
      ts: 50,
      partial: false,
      role: 'tool',
      author: 'tool',
      content: {
        kind: 'function_response',
        id: 'capability-operation-call',
        name: 'client_tool',
        result: {
          kind: 'text',
          text: 'outcome_unknown: the Host restarted after dispatching this Client Capability call. The client-side effect may have happened; do not retry it automatically.',
          uncertainOutcome: {
            code: 'outcome_unknown',
            retrySafe: false,
          },
        },
        isError: true,
      },
      refs: {
        operationId: 'capability-operation',
        toolCallId: 'capability-operation-call',
      },
    });
    assert.deepEqual(
      (await store.listUnsettledToolOperations('session-1')).map(
        (operation) => operation.operationId,
      ),
      ['ordinary-operation'],
    );
    assert.equal(await recoverClientCapabilityOutcomes(store, ['session-1'], () => 60), 0);
    assert.deepEqual(
      (await store.listUnsettledToolOperations('session-2')).map(
        (operation) => operation.operationId,
      ),
      ['other-session-operation'],
    );
  } finally {
    store.close();
  }
});

async function prepare(
  store: ReturnType<typeof createSqliteRuntimeStore>,
  operationId: string,
  recoveryMode: ToolRecoveryMode,
  sessionId = 'session-1',
): Promise<void> {
  const invocationId = `${operationId}-invocation`;
  const runId = `${operationId}-run`;
  const turnId = `${operationId}-turn`;
  const providerToolCallId = `${operationId}-call`;
  const args = { value: operationId };
  const canonicalArgsHash = canonicalToolArgsHash('client_tool', args);
  const call: RuntimeEvent = {
    id: `${operationId}_call`,
    invocationId,
    runId,
    sessionId,
    turnId,
    ts: 10,
    partial: false,
    role: 'model',
    author: 'agent',
    content: {
      kind: 'function_call',
      id: providerToolCallId,
      name: 'client_tool',
      args,
    },
    refs: { operationId, toolCallId: providerToolCallId },
  };
  const dispatch: RuntimeEvent = {
    id: `${operationId}_dispatch`,
    invocationId,
    runId,
    sessionId,
    turnId,
    ts: 10,
    partial: false,
    role: 'system',
    author: 'system',
    actions: {
      toolDispatch: {
        protocol: TOOL_BOUNDARY_PROTOCOL_V1,
        operationId,
        providerToolCallId,
        toolName: 'client_tool',
        canonicalArgsHash,
        recoveryMode,
      },
    },
    refs: { operationId, toolCallId: providerToolCallId },
  };
  await store.commitToolPrepared({
    operationId,
    journalEventId: `${operationId}_prepared`,
    runtimeEvent: call,
    dispatchRuntimeEvent: dispatch,
    providerToolCallId,
    toolName: 'client_tool',
    canonicalArgsHash,
    recoveryMode,
    committedAt: 10,
  });
}
