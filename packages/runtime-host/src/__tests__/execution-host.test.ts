import assert from 'node:assert/strict';
import { fork, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  appendFile,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { connect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { TOOL_BOUNDARY_PROTOCOL_V1 } from '@maka/core/runtime-event';
import { canonicalToolArgsHash } from '@maka/core/tool-args-identity';
import type { AgentRunHeader } from '@maka/core/agent-run';
import type { MessageContent } from '@maka/core/events';
import type { ConnectionCatalogEntry } from '@maka/core/runtime-policy';
import { decodeStoredMessage, type StoredMessage } from '@maka/core/session';
import type { Task } from '@maka/core/task-ledger';
import type { ScheduledTask } from '@maka/core/scheduled-task';
import { isTerminalRuntimeEvent } from '@maka/core/runtime-event';
import type { RuntimeEvent } from '@maka/core/runtime-event';
import { buildTaskLedgerTools } from '@maka/runtime/task-ledger-tools';
import {
  buildRecoveredTerminalRuntimeEvent,
  classifyTerminalRuntimeLedger,
  commitTerminalRunWithRuntimeFact,
} from '@maka/runtime/terminal-run-commit';
import {
  FAKE_ASK_SANDBOX_BOUNDARY_PROMPT,
  FAKE_ASK_USER_QUESTION_PROMPT,
  FAKE_WAIT_FOR_STEERING_PROMPT,
} from '@maka/runtime/fake-backend';
import { type MakaTool, type MakaToolContext } from '@maka/runtime/tool-runtime';
import {
  openInteractiveExecutionStoresForRead,
  openInteractiveExecutionStoresForWrite,
} from '@maka/storage/execution-stores';
import { openInteractiveRuntimePolicyStoresForWrite } from '@maka/storage/runtime-policy-stores';
import {
  resolveRootControlNamespace,
  resolveStorageRoot,
  tryAcquireInteractiveRootOwner,
  tryAcquireInteractiveRootReader,
  type StorageRootCapability,
} from '@maka/storage/root-authority';
import { openInteractiveTaskLedgerStoreForWrite } from '@maka/storage/task-ledger-authority';
import {
  connectRuntimeHost,
  RuntimeHostOperationError,
  RuntimeHostSubscriptionError,
  type RuntimeHostConnection,
  type RuntimeHostSessionSubscription,
} from '../client/index.js';
import {
  decodeHostFrame,
  RUNTIME_HOST_PROTOCOL_VERSION,
  TASK_LEDGER_PAGE_MAX_ITEMS,
  type ConnectionCatalogQueryResult,
  type InteractionPendingSnapshot,
  type SubscriptionFrame,
  type TaskLedgerQueryResult,
  type TaskLedgerRevision,
  type TurnMessageSubmitInput,
  type TurnSnapshot,
} from '../protocol/index.js';
import { SessionAdmissionGate } from '../server/session-admission-gate.js';
import { HostTaskLedgerCoordinator } from '../server/task-ledger-coordinator.js';
import { FramedTransport } from '../transport/framed-transport.js';

import {
  CONNECTION_EFFECT_MODEL_IDS,
  type ExecutionFixture,
  PROCESS_TIMEOUT_MS,
  SubscriptionProbe,
  assertJsonLines,
  attachment,
  connectClient,
  requireStartedTurn,
  operationError,
  quotedContent,
  sendStartWithoutReadingResponse,
  startConnectionEffectProvider,
  userRuntimeContent,
  waitForDurableMessageConflict,
  waitForPendingInteraction,
  waitForRunningTurn,
  waitForTerminalTurn,
  waitForTurn,
  withExecutionRoot,
  withTimeout,
} from './fixtures/execution-host-suite.js';

test('production Host resumes a Session through the ScheduledTask authority', {
  timeout: 30_000,
}, async () => {
  await withExecutionRoot(async (fixture) => {
    const host = await fixture.startHost();
    const desktop = await connectClient(fixture.root, 'desktop');
    const tui = await connectClient(fixture.root, 'tui');
    try {
      const heartbeat = await desktop.request('scheduled-task.mutate', {
        kind: 'create',
        input: {
          title: 'session resume execution proof',
          intentBody: 'Complete the scheduled execution proof.',
          schedule: { kind: 'once', runAt: Date.now() + 5_000 },
          effect: { kind: 'session_resume', sessionId: fixture.sessionId },
        },
      });
      assert.equal(heartbeat.kind, 'task');
      if (heartbeat.kind !== 'task') {
        return;
      }

      const observedHeartbeat = await waitForScheduledTaskCompletion(tui, heartbeat.task.id);
      assert.ok(observedHeartbeat.runs[0]?.runId);
      assert.equal(observedHeartbeat.lastError, null);

      const deletedHeartbeat = await tui.request('scheduled-task.mutate', {
        kind: 'delete',
        taskId: heartbeat.task.id,
      });
      assert.equal(deletedHeartbeat.kind, 'deleted');
    } finally {
      await Promise.allSettled([desktop.close(), tui.close()]);
      await fixture.stopHost(host);
    }
  });
});

test('production Host settles dispatched Client Capabilities before publishing Ready', async () => {
  await withExecutionRoot(async (fixture) => {
    const prepared = await seedDispatchedClientCapability(fixture);
    const host = await fixture.startHost({
      sessionId: fixture.sessionId,
      runId: prepared.runId,
    });
    try {
      const outcome = host.recoveryOutcome;
      assert.equal(outcome?.content?.kind, 'function_response');
      if (outcome?.content?.kind !== 'function_response') return;
      assert.equal(outcome.content.name, prepared.toolName);
      assert.equal(outcome.content.isError, true);
      assert.ok(outcome.content.result && typeof outcome.content.result === 'object');
      const recovered = outcome.content.result as {
        kind?: unknown;
        uncertainOutcome?: unknown;
      };
      assert.equal(recovered.kind, 'text');
      assert.deepEqual(recovered.uncertainOutcome, {
        code: 'outcome_unknown',
        retrySafe: false,
      });
    } finally {
      await fixture.stopHost(host);
    }
  });
});

test('dual UDS Clients query persisted Task Ledger tool-port mutations across Host restart', async () => {
  await withExecutionRoot(async (fixture) => {
    const initialRunId = randomUUID();
    const initialTurnId = randomUUID();
    // Exercise the Runtime-facing port before Host startup; Hosted tool composition is separate.
    const toolPortProjection = await withOwnedTaskLedgerToolPort(
      fixture,
      async (coordinator, tools) => {
        const context = taskLedgerToolContext(fixture, {
          runId: initialRunId,
          turnId: initialTurnId,
          toolCallId: randomUUID(),
        });
        const create = requireTaskLedgerTool<TaskCreateInput>(tools, 'task_create');
        const createInput = create.parameters.parse({
          tasks: Array.from({ length: TASK_LEDGER_PAGE_MAX_ITEMS + 1 }, (_, index) => ({
            subject: `Authority acceptance task ${index + 1}`,
          })),
        });
        await create.impl(createInput, context);

        const update = requireTaskLedgerTool<TaskUpdateInput>(tools, 'task_update');
        const updateInput = update.parameters.parse({ id: 'T1', status: 'in_progress' });
        await update.impl(updateInput, {
          ...context,
          toolCallId: randomUUID(),
        });
        return coordinator.list(fixture.sessionId, {
          includeTerminal: true,
          includeArchived: false,
          classifyResumeTrust: true,
        });
      },
    );
    assert.equal(toolPortProjection.length, TASK_LEDGER_PAGE_MAX_ITEMS + 1);
    assert.deepEqual(toolPortProjection[0]?.owner, {
      actor: 'main_agent',
      runId: initialRunId,
      turnId: initialTurnId,
    });

    const host = await fixture.startHost();
    const desktop = await connectClient(fixture.root, 'desktop');
    const tui = await connectClient(fixture.root, 'tui');
    let staleContinuation:
      | {
          revision: TaskLedgerRevision;
          cursor: string;
          task: Task;
        }
      | undefined;
    try {
      const desktopProjection = await collectTaskLedgerProjection(desktop, fixture.sessionId);
      const tuiProjection = await collectTaskLedgerProjection(tui, fixture.sessionId);
      assert.deepEqual(
        desktopProjection.pages.map((page) => page.tasks.length),
        [TASK_LEDGER_PAGE_MAX_ITEMS, 1],
      );
      assert.deepEqual(tuiProjection, desktopProjection);
      assert.deepEqual(desktopProjection.tasks, toolPortProjection);

      const byKey = await tui.request('task.ledger.query', {
        kind: 'get',
        sessionId: fixture.sessionId,
        taskRef: 'T1',
      });
      assert.equal(byKey.kind, 'task');
      if (byKey.kind !== 'task') throw new Error('Expected Task Ledger get result');
      assert.equal(byKey.sessionId, fixture.sessionId);
      assert.deepEqual(byKey.task, desktopProjection.tasks[0]);
      assert.equal(byKey.task?.owner?.runId, initialRunId);
      assert.equal(byKey.task?.owner?.turnId, initialTurnId);

      const firstPage = desktopProjection.pages[0];
      assert.ok(firstPage?.nextCursor);
      staleContinuation = {
        revision: firstPage.revision,
        cursor: firstPage.nextCursor,
        task: desktopProjection.tasks[1]!,
      };
    } finally {
      await Promise.allSettled([desktop.close(), tui.close()]);
      await fixture.stopHost(host);
    }

    assert.ok(staleContinuation);
    const { revision: staleRevision, cursor: staleCursor, task: taskToChange } = staleContinuation;
    const successorTurnId = randomUUID();
    const changedSubject = `${taskToChange.subject} after authority reacquisition`;
    await withOwnedTaskLedgerToolPort(fixture, async (_coordinator, tools) => {
      const update = requireTaskLedgerTool<TaskUpdateInput>(tools, 'task_update');
      const input = update.parameters.parse({
        id: taskToChange.key,
        subject: changedSubject,
      });
      await update.impl(
        input,
        taskLedgerToolContext(fixture, {
          runId: randomUUID(),
          turnId: successorTurnId,
          toolCallId: randomUUID(),
        }),
      );
    });

    const successorHost = await fixture.startHost();
    const successor = await connectClient(fixture.root, 'desktop');
    try {
      const continued = await successor.request('task.ledger.query', {
        kind: 'list_continue',
        sessionId: fixture.sessionId,
        revision: staleRevision,
        cursor: staleCursor,
      });
      assert.equal(continued.kind, 'revision_changed');
      if (continued.kind !== 'revision_changed') {
        throw new Error('Expected stale Task Ledger continuation to report revision_changed');
      }
      assert.equal(continued.expected, staleRevision);
      assert.notEqual(continued.actual, staleRevision);

      const changed = await successor.request('task.ledger.query', {
        kind: 'get',
        sessionId: fixture.sessionId,
        taskRef: taskToChange.key,
      });
      assert.equal(changed.kind, 'task');
      if (changed.kind !== 'task') throw new Error('Expected changed Task Ledger task result');
      assert.equal(changed.sessionId, fixture.sessionId);
      assert.equal(changed.task?.subject, changedSubject);
      assert.equal(changed.revision, continued.actual);
    } finally {
      await successor.close();
      await fixture.stopHost(successorHost);
    }
  });
});

async function seedDispatchedClientCapability(
  fixture: ExecutionFixture,
): Promise<{ runId: string; toolName: string }> {
  const owner = await tryAcquireInteractiveRootOwner(fixture.capability);
  assert.ok(owner);
  if (!owner) throw new Error('Unable to acquire execution root for Client Capability setup');
  let stores: Awaited<ReturnType<typeof openInteractiveExecutionStoresForWrite>> | undefined;
  try {
    stores = await openInteractiveExecutionStoresForWrite(owner.lease);
    const operationId = 'client-capability-before-ready';
    const invocationId = `${operationId}-invocation`;
    const runId = `${operationId}-run`;
    const turnId = `${operationId}-turn`;
    const providerToolCallId = `${operationId}-call`;
    const toolName = 'mcp__client_fixture__navigate';
    const args = { url: 'https://example.test/recovery' };
    const canonicalArgsHash = canonicalToolArgsHash(toolName, args);
    const call: RuntimeEvent = {
      id: `${operationId}_call`,
      invocationId,
      runId,
      sessionId: fixture.sessionId,
      turnId,
      ts: 10,
      partial: false,
      role: 'model',
      author: 'agent',
      content: {
        kind: 'function_call',
        id: providerToolCallId,
        name: toolName,
        args,
      },
      refs: { operationId, toolCallId: providerToolCallId },
    };
    const dispatch: RuntimeEvent = {
      id: `${operationId}_dispatch`,
      invocationId,
      runId,
      sessionId: fixture.sessionId,
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
          toolName,
          canonicalArgsHash,
          recoveryMode: 'outcome_unknown',
        },
      },
      refs: { operationId, toolCallId: providerToolCallId },
    };
    await stores.runtimeEventStore.commitToolPrepared({
      operationId,
      journalEventId: `${operationId}_prepared`,
      runtimeEvent: call,
      dispatchRuntimeEvent: dispatch,
      providerToolCallId,
      toolName,
      canonicalArgsHash,
      recoveryMode: 'outcome_unknown',
      committedAt: 10,
    });
    return { runId, toolName };
  } finally {
    await stores?.sessionStore.close?.();
    await owner.close();
  }
}

test('two UDS Clients share one Runtime Policy authority and CAS winner', async () => {
  await withExecutionRoot(async (fixture) => {
    const host = await fixture.startHost();
    const first = await connectClient(fixture.root, 'desktop');
    const second = await connectClient(fixture.root, 'tui');
    try {
      const initial = await first.request('runtime.policy.query', {});
      assert.deepEqual(await second.request('runtime.policy.query', {}), initial);
      const outcomes = await Promise.all([
        first.request('runtime.policy.mutate', {
          expectedRevision: initial.revision,
          operation: {
            kind: 'set_personalization',
            value: { displayName: 'Desktop', assistantTone: 'precise' },
          },
        }),
        second.request('runtime.policy.mutate', {
          expectedRevision: initial.revision,
          operation: {
            kind: 'set_memory',
            value: { enabled: false, agentReadEnabled: false },
          },
        }),
      ]);
      assert.deepEqual(outcomes.map((outcome) => outcome.kind).sort(), [
        'committed',
        'revision_conflict',
      ]);
      assert.deepEqual(
        await first.request('runtime.policy.query', {}),
        await second.request('runtime.policy.query', {}),
      );
    } finally {
      await Promise.allSettled([first.close(), second.close()]);
      await fixture.stopHost(host);
    }
  });
});

test('two UDS Clients await slow connection effects against one canonical catalog', async () => {
  const provider = await startConnectionEffectProvider({ responseDelayMs: 2_100 });
  try {
    await withExecutionRoot(async (fixture) => {
      const secret = 'connection-effect-secret';
      const connection = await fixture.seedConnectionEffect(provider.baseUrl, secret);
      const host = await fixture.startHost();
      const desktop = await connectClient(fixture.root, 'desktop');
      const tui = await connectClient(fixture.root, 'tui');
      try {
        assert.equal(desktop.hostEpoch, tui.hostEpoch);
        assert.notEqual(desktop.connectionId, tui.connectionId);
        const fetchInput = { connectionId: connection.connectionId };
        const fetched = await desktop.request('connection.models.fetch', {
          ...fetchInput,
        });
        assert.equal(fetched.kind, 'committed');
        if (fetched.kind !== 'committed') return;
        assert.equal(fetched.modelCount, CONNECTION_EFFECT_MODEL_IDS.length);
        assert.equal(fetched.source, 'fetched');

        const firstPage = await tui.request('connection.catalog.query', { kind: 'start' });
        assert.equal(firstPage.kind, 'page');
        if (firstPage.kind !== 'page') return;
        type CatalogPage = Extract<ConnectionCatalogQueryResult, { readonly kind: 'page' }>;
        const pages: CatalogPage[] = [firstPage];
        let observed: CatalogPage = firstPage;
        while (observed.nextCursor) {
          const nextResult: ConnectionCatalogQueryResult = await tui.request(
            'connection.catalog.query',
            {
              kind: 'continue',
              revision: observed.revision,
              cursor: observed.nextCursor,
            },
          );
          assert.equal(nextResult.kind, 'page');
          if (nextResult.kind !== 'page') return;
          pages.push(nextResult);
          observed = nextResult;
        }
        assert.ok(pages.length > 1);
        assert.ok(pages.every((page) => page.revision === fetched.catalogRevision));
        assert.deepEqual(
          pages.flatMap((page) =>
            page.items.flatMap((item) => (item.kind === 'model' ? [item.model.id] : [])),
          ),
          CONNECTION_EFFECT_MODEL_IDS,
        );

        const testInput = {
          connectionId: connection.connectionId,
          modelId: CONNECTION_EFFECT_MODEL_IDS[0]!,
        };
        const tested = await tui.request('connection.test.run', {
          ...testInput,
        });
        assert.equal(tested.kind, 'committed');
        if (tested.kind !== 'committed') return;
        assert.equal(tested.test.kind, 'verified');

        const canonical = await desktop.request('connection.catalog.query', { kind: 'start' });
        assert.equal(canonical.kind, 'page');
        if (canonical.kind !== 'page') return;
        const header = canonical.items.find(
          (item) => item.kind === 'connection' && item.connectionId === connection.connectionId,
        );
        assert.equal(header?.kind, 'connection');
        if (header?.kind === 'connection') {
          assert.deepEqual(header.lastTest, {
            status: 'verified',
            checkedAt: tested.test.checkedAt,
          });
        }
        assert.equal(
          JSON.stringify([fetchInput, fetched, pages, testInput, tested, canonical]).includes(
            secret,
          ),
          false,
        );
        assert.equal(provider.requests.length, 2);
        assert.ok(
          provider.requests.every(({ authorization }) => authorization === `Bearer ${secret}`),
        );
        assert.deepEqual(
          provider.requests.map(({ method, url }) => ({
            method,
            url,
          })),
          [
            {
              method: 'GET',
              url: '/v1/models',
            },
            {
              method: 'POST',
              url: '/v1/chat/completions',
            },
          ],
        );
      } finally {
        await Promise.allSettled([desktop.close(), tui.close()]);
        await fixture.stopHost(host);
      }
    });
  } finally {
    await provider.close();
  }
});

test('two Clients share one execution after the starting Client disconnects', async () => {
  await withExecutionRoot(async (fixture) => {
    const host = await fixture.startHost();
    const first = await connectClient(fixture.root, 'desktop');
    const second = await connectClient(fixture.root, 'tui');
    const turnId = randomUUID();

    const started = requireStartedTurn(
      await first.startTurn(
        {
          sessionId: fixture.sessionId,
          turnId,
          content: { text: FAKE_ASK_USER_QUESTION_PROMPT },
        },
        PROCESS_TIMEOUT_MS,
      ),
    );
    assert.equal(started.turnId, turnId);
    const secondSubscription = await second.openSessionSubscription({
      sessionId: fixture.sessionId,
      transcript: { kind: 'tail', maxBytes: 16 * 1024 },
    });
    const transcript = await secondSubscription.loadTranscript(decodeStoredMessage);
    assert.ok(
      transcript.some(
        (message) =>
          message.type === 'user' &&
          message.turnId === turnId &&
          message.text === FAKE_ASK_USER_QUESTION_PROMPT,
      ),
    );
    const secondProbe = new SubscriptionProbe(secondSubscription);
    await assert.rejects(
      () =>
        second.startTurn(
          {
            sessionId: fixture.sessionId,
            turnId: randomUUID(),
            content: { text: 'must stay busy' },
          },
          PROCESS_TIMEOUT_MS,
        ),
      operationError('session_busy'),
    );

    await first.close();
    const pending = await waitForPendingInteraction(secondSubscription, secondProbe, started.runId);
    assert.equal(pending.sessionId, fixture.sessionId);
    assert.equal(pending.turnId, turnId);
    assert.equal(pending.runId, started.runId);
    const questionRequest = pending.request;
    assert.ok(questionRequest.kind === 'question');
    assert.deepEqual(
      await second.request('interaction.query', {
        sessionId: fixture.sessionId,
        interactionId: pending.interactionId,
      }),
      pending,
    );
    const observed = await second.queryTurn({
      sessionId: fixture.sessionId,
      turnId,
    });
    assert.equal(observed.runId, started.runId);
    assert.ok(observed.status === 'running' || observed.status === 'waiting_for_user');
    const stopped = await second.stopTurn(
      {
        sessionId: fixture.sessionId,
        turnId,
        runId: started.runId,
      },
      PROCESS_TIMEOUT_MS,
    );
    assert.equal(stopped.status, 'cancelled');
    const closed = await second.request('interaction.query', {
      sessionId: fixture.sessionId,
      interactionId: pending.interactionId,
    });
    assert.equal(closed.sessionId, fixture.sessionId);
    assert.equal(closed.turnId, turnId);
    assert.equal(closed.runId, started.runId);
    assert.equal(closed.status, 'closed');
    assert.equal(closed.outcome.kind, 'closure');
    if (closed.outcome.kind === 'closure') assert.equal(closed.outcome.reason, 'turn_stopped');
    await assert.rejects(
      () =>
        second.request('interaction.answer', {
          sessionId: fixture.sessionId,
          interactionId: pending.interactionId,
          answer: {
            kind: 'question',
            answers: questionRequest.questions.map(() => null),
          },
        }),
      operationError('already_resolved'),
    );

    const nextTurnId = randomUUID();
    const next = requireStartedTurn(
      await second.startTurn(
        {
          sessionId: fixture.sessionId,
          turnId: nextTurnId,
          content: { text: FAKE_ASK_USER_QUESTION_PROMPT },
        },
        PROCESS_TIMEOUT_MS,
      ),
    );
    assert.deepEqual(
      requireStartedTurn(
        await second.startTurn(
          {
            sessionId: fixture.sessionId,
            turnId,
            content: { text: FAKE_ASK_USER_QUESTION_PROMPT },
          },
          PROCESS_TIMEOUT_MS,
        ),
      ),
      stopped,
    );
    assert.deepEqual(
      await second.stopTurn({
        sessionId: fixture.sessionId,
        turnId,
        runId: started.runId,
      }),
      stopped,
    );
    const nextObserved = await second.queryTurn({
      sessionId: fixture.sessionId,
      turnId: nextTurnId,
    });
    assert.equal(nextObserved.runId, next.runId);
    assert.ok(nextObserved.status === 'running' || nextObserved.status === 'waiting_for_user');
    await second.stopTurn(
      {
        sessionId: fixture.sessionId,
        turnId: nextTurnId,
        runId: next.runId,
      },
      PROCESS_TIMEOUT_MS,
    );
    await secondSubscription.close();
    await secondProbe.done;
    await second.close();
    await fixture.stopHost(host);

    const ledger = await fixture.readTurn(turnId);
    assert.equal(ledger.runs.length, 1);
    assert.equal(ledger.userMessages.length, 1);
    assert.equal(ledger.terminalEvents.length, 1);
    assert.equal(ledger.classification.kind, 'fact');
    if (ledger.classification.kind === 'fact') {
      assert.equal(ledger.classification.fact.runStatus, 'cancelled');
      assert.notEqual(ledger.classification.fact.failureClass, 'app_restarted');
    }
  });
});

test('regenerate replays the durable source content with one recoverable root identity', async () => {
  await withExecutionRoot(async (fixture) => {
    const host = await fixture.startHost();
    const client = await connectClient(fixture.root, 'tui');
    const sourceTurnId = randomUUID();
    const regeneratedTurnId = randomUUID();
    try {
      await client.startTurn(
        {
          sessionId: fixture.sessionId,
          turnId: sourceTurnId,
          content: quotedContent('repeat this request'),
        },
        PROCESS_TIMEOUT_MS,
      );
      await waitForTerminalTurn(client, fixture.sessionId, sourceTurnId);

      const started = await client.regenerateTurn(
        {
          sessionId: fixture.sessionId,
          sourceTurnId,
          turnId: regeneratedTurnId,
        },
        PROCESS_TIMEOUT_MS,
      );
      const terminal = await waitForTerminalTurn(client, fixture.sessionId, regeneratedTurnId);
      assert.equal(terminal.runId, started.runId);
      assert.deepEqual(
        await client.regenerateTurn({
          sessionId: fixture.sessionId,
          sourceTurnId,
          turnId: regeneratedTurnId,
        }),
        terminal,
      );
    } finally {
      await client.close();
      await fixture.stopHost(host);
    }

    const ledger = await fixture.readTurn(regeneratedTurnId);
    assert.equal(ledger.runs.length, 1);
    assert.equal(ledger.userMessages.length, 1);
    assert.equal(ledger.runs[0]?.parentTurnId, sourceTurnId);
    assert.equal(ledger.runs[0]?.regeneratedFromTurnId, sourceTurnId);
    assert.deepEqual(
      {
        text: ledger.userMessages[0]?.text,
        quotes: ledger.userMessages[0]?.quotes,
      },
      quotedContent('repeat this request'),
    );
  });
});

test('regenerate rejects self-source and legacy target collisions without draining Host', async () => {
  await withExecutionRoot(async (fixture) => {
    const firstHost = await fixture.startHost();
    const first = await connectClient(fixture.root, 'tui');
    const sourceTurnId = randomUUID();
    await first.startTurn({
      sessionId: fixture.sessionId,
      turnId: sourceTurnId,
      content: { text: 'source request' },
    });
    await waitForTerminalTurn(first, fixture.sessionId, sourceTurnId);
    await assert.rejects(
      first.regenerateTurn({
        sessionId: fixture.sessionId,
        sourceTurnId,
        turnId: sourceTurnId,
      }),
      operationError('operation_conflict'),
    );
    await first.close();
    await fixture.stopHost(firstHost);

    const legacy = await fixture.seedSafeBoundaryContinuationSource();
    const secondHost = await fixture.startHost();
    const second = await connectClient(fixture.root, 'desktop');
    try {
      await assert.rejects(
        second.regenerateTurn({
          sessionId: fixture.sessionId,
          sourceTurnId,
          turnId: legacy.sourceTurnId,
        }),
        operationError('operation_conflict'),
      );
      const followingTurnId = randomUUID();
      await second.startTurn({
        sessionId: fixture.sessionId,
        turnId: followingTurnId,
        content: { text: 'Host remains available' },
      });
      assert.equal(
        (await waitForTerminalTurn(second, fixture.sessionId, followingTurnId)).status,
        'completed',
      );
    } finally {
      await second.close();
      await fixture.stopHost(secondHost);
    }
    assert.deepEqual(await fixture.readTurnFootprint(legacy.sourceTurnId), {
      admitted: false,
      runCount: 1,
      userMessageCount: 0,
    });
  });
});

test('context actions share root admission and expose backend capability honestly', async () => {
  await withExecutionRoot(async (fixture) => {
    const host = await fixture.startHost();
    const first = await connectClient(fixture.root, 'desktop');
    const second = await connectClient(fixture.root, 'tui');
    const turnId = randomUUID();
    const unavailableTurnId = randomUUID();
    try {
      assert.deepEqual(await first.queryContextDiagnostics({ sessionId: fixture.sessionId }), {
        status: 'unavailable',
        reason: 'no_completed_request',
      });
      const started = requireStartedTurn(
        await first.startTurn({
          sessionId: fixture.sessionId,
          turnId,
          content: { text: FAKE_ASK_USER_QUESTION_PROMPT },
        }),
      );
      await waitForRunningTurn(second, fixture.sessionId, turnId);
      await assert.rejects(
        second.compactContext({
          sessionId: fixture.sessionId,
          turnId: randomUUID(),
        }),
        operationError('session_busy'),
      );
      await second.stopTurn({
        sessionId: fixture.sessionId,
        turnId,
        runId: started.runId,
      });
      await assert.rejects(
        second.compactContext({
          sessionId: fixture.sessionId,
          turnId: unavailableTurnId,
        }),
        operationError('operation_unavailable'),
      );
      await assert.rejects(
        second.queryContextDiagnostics({ sessionId: 'missing-session' }),
        operationError('not_found'),
      );
    } finally {
      await Promise.allSettled([first.close(), second.close()]);
      await fixture.stopHost(host);
    }
    assert.deepEqual(await fixture.readTurnFootprint(unavailableTurnId), {
      admitted: false,
      runCount: 0,
      userMessageCount: 0,
    });
  });
});

test('a disconnected Client leaves a durable Interaction that another Client can answer', async () => {
  await withExecutionRoot(async (fixture) => {
    const firstHost = await fixture.startHost();
    const first = await connectClient(fixture.root, 'desktop');
    const turnId = randomUUID();
    const started = requireStartedTurn(
      await first.startTurn({
        sessionId: fixture.sessionId,
        turnId,
        content: { text: FAKE_ASK_USER_QUESTION_PROMPT },
      }),
    );
    await first.close();

    const second = await connectClient(fixture.root, 'tui');
    const subscription = await second.openSessionSubscription({
      sessionId: fixture.sessionId,
      transcript: { kind: 'none' },
    });
    const probe = new SubscriptionProbe(subscription);
    const pending = await waitForPendingInteraction(subscription, probe, started.runId);
    assert.equal(pending.sessionId, fixture.sessionId);
    assert.equal(pending.turnId, turnId);
    assert.equal(pending.runId, started.runId);
    assert.equal(pending.status, 'pending');
    const questionRequest = pending.request;
    assert.ok(questionRequest.kind === 'question');

    assert.deepEqual(
      await second.request('interaction.query', {
        sessionId: fixture.sessionId,
        interactionId: pending.interactionId,
      }),
      pending,
    );
    const answer = {
      kind: 'question' as const,
      answers: questionRequest.questions.map((question) => question.options[0]?.label ?? null),
    };
    const winner = await second.request('interaction.answer', {
      sessionId: fixture.sessionId,
      interactionId: pending.interactionId,
      answer,
    });
    assert.equal(winner.sessionId, fixture.sessionId);
    assert.equal(winner.turnId, turnId);
    assert.equal(winner.runId, started.runId);
    assert.equal(winner.status, 'answered');
    assert.equal(winner.outcome.kind, 'question_answer');
    assert.deepEqual(winner.outcome.answers, answer.answers);
    assert.deepEqual(
      await second.request('interaction.query', {
        sessionId: fixture.sessionId,
        interactionId: pending.interactionId,
      }),
      winner,
    );
    assert.deepEqual(
      await second.request('interaction.answer', {
        sessionId: fixture.sessionId,
        interactionId: pending.interactionId,
        answer,
      }),
      winner,
    );
    const resumed = await probe.waitFor(
      (frame) =>
        frame.kind === 'subscription.session_projection' &&
        frame.snapshot.session.status === 'running' &&
        frame.snapshot.rootTurn?.runId === started.runId &&
        frame.snapshot.rootTurn.status === 'running' &&
        frame.snapshot.interactions.pending.length === 0,
      'continuity did not publish the resumed Turn after the question answer',
    );
    assert.equal(resumed.kind, 'subscription.session_projection');
    const completed = await waitForTerminalTurn(second, fixture.sessionId, turnId);
    assert.equal(completed.runId, started.runId);
    assert.equal(completed.status, 'completed');
    await subscription.close();
    await probe.done;
    await second.close();
    await fixture.stopHost(firstHost);

    const secondHost = await fixture.startHost();
    const observer = await connectClient(fixture.root, 'run');
    assert.deepEqual(
      await observer.request('interaction.query', {
        sessionId: fixture.sessionId,
        interactionId: pending.interactionId,
      }),
      winner,
    );
    assert.deepEqual(
      await observer.request('interaction.answer', {
        sessionId: fixture.sessionId,
        interactionId: pending.interactionId,
        answer,
      }),
      winner,
    );
    assert.deepEqual(await observer.queryTurn({ sessionId: fixture.sessionId, turnId }), completed);
    await observer.close();
    await fixture.stopHost(secondHost);
  });
});

test('two UDS Clients settle one hosted sandbox boundary and resume its exact Run', async () => {
  await withExecutionRoot(async (fixture) => {
    const firstHost = await fixture.startHost();
    const starter = await connectClient(fixture.root, 'desktop');
    const first = await connectClient(fixture.root, 'tui');
    const second = await connectClient(fixture.root, 'run');
    const subscription = await first.openSessionSubscription({
      sessionId: fixture.sessionId,
      transcript: { kind: 'none' },
    });
    const probe = new SubscriptionProbe(subscription);
    const turnId = randomUUID();
    const started = requireStartedTurn(
      await starter.startTurn({
        sessionId: fixture.sessionId,
        turnId,
        content: { text: FAKE_ASK_SANDBOX_BOUNDARY_PROMPT },
      }),
    );
    await starter.close();

    const pending = await waitForPendingInteraction(subscription, probe, started.runId);
    assert.equal(pending.sessionId, fixture.sessionId);
    assert.equal(pending.turnId, turnId);
    assert.equal(pending.runId, started.runId);
    assert.equal(pending.status, 'pending');
    assert.equal(pending.request.kind, 'sandbox_boundary');
    if (pending.request.kind !== 'sandbox_boundary') return;
    assert.deepEqual(pending.request.expansion, { network: { enabled: true } });

    const answer = {
      sessionId: fixture.sessionId,
      interactionId: pending.interactionId,
      answer: { kind: 'sandbox_boundary', decision: 'allow' },
    } as const;
    const [firstWinner, secondWinner] = await Promise.all([
      first.request('interaction.answer', answer),
      second.request('interaction.answer', answer),
    ]);
    assert.deepEqual(firstWinner, secondWinner);
    assert.equal(firstWinner.status, 'answered');
    assert.equal(firstWinner.outcome.kind, 'sandbox_boundary_decision');
    if (firstWinner.outcome.kind !== 'sandbox_boundary_decision') return;
    assert.equal(firstWinner.outcome.decision, 'allow');
    assert.equal(firstWinner.outcome.status, 'approved');
    assert.equal(Number.isSafeInteger(firstWinner.outcome.committedAt), true);
    assert.deepEqual(
      await first.request('interaction.query', {
        sessionId: fixture.sessionId,
        interactionId: pending.interactionId,
      }),
      firstWinner,
    );
    await probe.waitFor(
      (frame) =>
        frame.kind === 'subscription.session_projection' &&
        frame.snapshot.rootTurn?.runId === started.runId &&
        frame.snapshot.interactions.pending.length === 0,
      'continuity did not publish the resumed Turn after the sandbox boundary answer',
    );
    const completed = await waitForTerminalTurn(first, fixture.sessionId, turnId);
    assert.equal(completed.runId, started.runId);
    assert.equal(completed.status, 'completed');

    await subscription.close();
    await probe.done;
    await Promise.allSettled([first.close(), second.close()]);
    await fixture.stopHost(firstHost);

    const secondHost = await fixture.startHost();
    const observer = await connectClient(fixture.root, 'desktop');
    assert.deepEqual(
      await observer.request('interaction.query', {
        sessionId: fixture.sessionId,
        interactionId: pending.interactionId,
      }),
      firstWinner,
    );
    assert.deepEqual(await observer.queryTurn({ sessionId: fixture.sessionId, turnId }), completed);
    await observer.close();
    await fixture.stopHost(secondHost);
  });
});

interface TaskCreateInput {
  tasks: Array<{ subject: string; parent_id?: string }>;
}

interface TaskUpdateInput {
  id: string;
  status?: 'pending' | 'in_progress' | 'blocked' | 'completed' | 'failed' | 'cancelled';
  subject?: string;
  blockedReason?: string;
  failureReason?: string;
  completionEvidence?: string;
  explicitReopen?: boolean;
}

type TaskLedgerPage = Extract<TaskLedgerQueryResult, { kind: 'page' }>;
type TaskLedgerTool<Input> = MakaTool<Input, string> & {
  parameters: { parse(value: unknown): Input };
};

async function withOwnedTaskLedgerToolPort<T>(
  fixture: ExecutionFixture,
  run: (coordinator: HostTaskLedgerCoordinator, tools: MakaTool[]) => Promise<T>,
): Promise<T> {
  const owner = await tryAcquireInteractiveRootOwner(fixture.capability);
  assert.ok(owner);
  if (!owner) throw new Error('Unable to acquire the interactive Task Ledger tool port');
  let writer: Awaited<ReturnType<typeof openInteractiveTaskLedgerStoreForWrite>> | undefined;
  try {
    writer = await openInteractiveTaskLedgerStoreForWrite(owner.lease);
    const coordinator = new HostTaskLedgerCoordinator(writer, new SessionAdmissionGate(), {
      probeSessionRemoval: async () => ({ kind: 'present' }),
    });
    return await run(coordinator, buildTaskLedgerTools({ store: coordinator }));
  } finally {
    writer?.close();
    await owner.close();
  }
}

function requireTaskLedgerTool<Input>(
  tools: readonly MakaTool[],
  name: 'task_create' | 'task_update',
): TaskLedgerTool<Input> {
  const tool = tools.find((candidate) => candidate.name === name);
  assert.ok(tool, `Expected ${name} Runtime tool`);
  return tool as TaskLedgerTool<Input>;
}

function taskLedgerToolContext(
  fixture: ExecutionFixture,
  identity: Pick<MakaToolContext, 'runId' | 'turnId' | 'toolCallId'>,
): MakaToolContext {
  return {
    sessionId: fixture.sessionId,
    cwd: fixture.root,
    ...identity,
    abortSignal: new AbortController().signal,
    emitOutput: () => {},
  };
}

async function collectTaskLedgerProjection(
  client: RuntimeHostConnection,
  sessionId: string,
): Promise<{
  revision: TaskLedgerRevision;
  pages: TaskLedgerPage[];
  tasks: Task[];
}> {
  const pages: TaskLedgerPage[] = [];
  let result = await client.request('task.ledger.query', {
    kind: 'list_start',
    sessionId,
  });
  assert.equal(result.kind, 'page');
  if (result.kind !== 'page') throw new Error('Expected initial Task Ledger page');
  const revision = result.revision;

  while (true) {
    assert.equal(result.sessionId, sessionId);
    assert.equal(result.revision, revision);
    pages.push(result);
    if (result.nextCursor === null) break;
    result = await client.request('task.ledger.query', {
      kind: 'list_continue',
      sessionId,
      revision,
      cursor: result.nextCursor,
    });
    assert.equal(result.kind, 'page');
    if (result.kind !== 'page') {
      throw new Error('Task Ledger changed while collecting a stable projection');
    }
  }

  return {
    revision,
    pages,
    tasks: pages.flatMap((page) => page.tasks),
  };
}

async function waitForScheduledTaskCompletion(
  client: RuntimeHostConnection,
  taskId: string,
): Promise<ScheduledTask> {
  const deadline = Date.now() + 20_000;
  let last: ScheduledTask | null = null;
  while (Date.now() < deadline) {
    const result = await client.request('scheduled-task.query', {
      kind: 'get',
      taskId,
    });
    if (result.kind === 'task' && result.task?.status === 'completed') return result.task;
    if (result.kind === 'task') last = result.task;
    if (result.kind === 'task' && result.task?.lastError) {
      throw new Error(`ScheduledTask execution failed: ${result.task.lastError}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(
    `ScheduledTask ${taskId} did not settle before the deadline: ${JSON.stringify(last)}`,
  );
}
