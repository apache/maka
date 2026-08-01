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
import { canonicalToolArgsHash, TOOL_BOUNDARY_PROTOCOL_V1 } from '@maka/core';
import type { AgentRunHeader } from '@maka/core/agent-run';
import type { MessageContent } from '@maka/core/events';
import type { ConnectionCatalogEntry } from '@maka/core/runtime-policy';
import type { StoredMessage } from '@maka/core/session';
import type { Task } from '@maka/core/task-ledger';
import { isTerminalRuntimeEvent } from '@maka/core/runtime-event';
import type { RuntimeEvent } from '@maka/core/runtime-event';
import {
  buildTaskLedgerTools,
  buildRecoveredTerminalRuntimeEvent,
  classifyTerminalRuntimeLedger,
  commitTerminalRunWithRuntimeFact,
  FAKE_ASK_USER_QUESTION_PROMPT,
  FAKE_WAIT_FOR_STEERING_PROMPT,
  type MakaTool,
  type MakaToolContext,
} from '@maka/runtime';
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

const CURRENT_PROTOCOL = {
  min: RUNTIME_HOST_PROTOCOL_VERSION,
  max: RUNTIME_HOST_PROTOCOL_VERSION,
} as const;
const PROCESS_TIMEOUT_MS = 10_000;
const CONNECTION_EFFECT_MODEL_IDS = Array.from(
  { length: 129 },
  (_, index) => `connection-effect-model-${String(index + 1).padStart(3, '0')}`,
);

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
  try {
    const stores = await openInteractiveExecutionStoresForWrite(owner.lease);
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
    const secondSubscription = await second.openSessionSubscription({
      sessionId: fixture.sessionId,
    });
    const secondProbe = new SubscriptionProbe(secondSubscription);
    const turnId = randomUUID();

    const started = await first.startTurn({
      sessionId: fixture.sessionId,
      turnId,
      content: { text: FAKE_ASK_USER_QUESTION_PROMPT },
    });
    assert.equal(started.turnId, turnId);
    await assert.rejects(
      () =>
        second.startTurn({
          sessionId: fixture.sessionId,
          turnId: randomUUID(),
          content: { text: 'must stay busy' },
        }),
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
          interactionId: pending.interactionId,
          answer: {
            kind: 'question',
            answers: questionRequest.questions.map(() => null),
          },
        }),
      operationError('already_resolved'),
    );

    const nextTurnId = randomUUID();
    const next = await second.startTurn({
      sessionId: fixture.sessionId,
      turnId: nextTurnId,
      content: { text: FAKE_ASK_USER_QUESTION_PROMPT },
    });
    assert.deepEqual(
      await second.startTurn({
        sessionId: fixture.sessionId,
        turnId,
        content: { text: FAKE_ASK_USER_QUESTION_PROMPT },
      }),
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

test('a disconnected Client leaves a durable Interaction that another Client can answer', async () => {
  await withExecutionRoot(async (fixture) => {
    const firstHost = await fixture.startHost();
    const first = await connectClient(fixture.root, 'desktop');
    const turnId = randomUUID();
    const started = await first.startTurn({
      sessionId: fixture.sessionId,
      turnId,
      content: { text: FAKE_ASK_USER_QUESTION_PROMPT },
    });
    await first.close();

    const second = await connectClient(fixture.root, 'tui');
    const subscription = await second.openSessionSubscription({ sessionId: fixture.sessionId });
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

test('subscribed Clients share one canonical queue and ordered root handoff', async () => {
  await withExecutionRoot(async (fixture) => {
    const host = await fixture.startHost();
    const desktop = await connectClient(fixture.root, 'desktop');
    const tui = await connectClient(fixture.root, 'tui');
    const desktopSubscription = await desktop.openSessionSubscription({
      sessionId: fixture.sessionId,
    });
    const tuiSubscription = await tui.openSessionSubscription({ sessionId: fixture.sessionId });
    const desktopProbe = new SubscriptionProbe(desktopSubscription);
    const tuiProbe = new SubscriptionProbe(tuiSubscription);
    for (const subscription of [desktopSubscription, tuiSubscription]) {
      assert.equal(subscription.hostEpoch, host.hostEpoch);
      assert.equal(subscription.snapshot.rootTurn, null);
      assert.equal(subscription.snapshot.projectionRevision, 1);
      assert.equal(subscription.snapshot.queue.hostEpoch, host.hostEpoch);
    }

    const firstTurnId = randomUUID();
    const started = await desktop.startTurn({
      sessionId: fixture.sessionId,
      turnId: firstTurnId,
      content: { text: `continuity root ${'x'.repeat(540)}` },
    });
    for (const probe of [desktopProbe, tuiProbe]) {
      const liveDelta = await probe.waitFor(
        (frame) =>
          frame.kind === 'subscription.session_delta' && frame.delta.turnId === firstTurnId,
        'continuity did not publish the live assistant delta',
      );
      assert.equal(liveDelta.kind, 'subscription.session_delta');
      if (liveDelta.kind === 'subscription.session_delta') {
        assert.equal(liveDelta.delta.runId, started.runId);
      }
    }

    const followupId = randomUUID();
    const followupContent = { text: 'continue after the first root completes' };
    const queued = await tui.request('turn.message.submit', {
      originHostEpoch: host.hostEpoch,
      sessionId: fixture.sessionId,
      messageId: followupId,
      content: followupContent,
      placement: 'next_turn',
    });
    assert.equal(queued.disposition, 'followup');
    for (const probe of [desktopProbe, tuiProbe]) {
      const queueProjection = await probe.waitFor(
        (frame) =>
          frame.kind === 'subscription.session_projection' &&
          frame.snapshot.queue.followup.some((entry) => entry.messageId === followupId),
        'continuity did not publish the accepted follow-up',
      );
      assert.equal(queueProjection.kind, 'subscription.session_projection');
    }

    await desktop.close();
    await desktopProbe.waitForFailure('connection_closed');
    assert.equal((await tui.status()).connections, 1);
    const terminal = await tuiProbe.waitFor(
      (frame) =>
        frame.kind === 'subscription.session_projection' &&
        frame.snapshot.rootTurn?.turnId === firstTurnId &&
        frame.snapshot.rootTurn.status === 'completed',
      'continuity did not publish the terminal root cut',
    );
    assert.equal(terminal.kind, 'subscription.session_projection');
    const successor = await tuiProbe.waitFor(
      (frame) =>
        frame.kind === 'subscription.session_projection' &&
        frame.snapshot.rootTurn !== null &&
        frame.snapshot.rootTurn.turnId !== firstTurnId,
      'continuity did not publish the successor root',
    );
    assert.equal(successor.kind, 'subscription.session_projection');
    if (successor.kind !== 'subscription.session_projection' || !successor.snapshot.rootTurn) {
      return;
    }
    assert.equal(successor.snapshot.rootTurn.sessionId, fixture.sessionId);
    assert.ok(tuiProbe.indexOf(terminal) < tuiProbe.indexOf(successor));
    await tuiSubscription.close();
    await tuiProbe.done;
    await waitForTerminalTurn(tui, fixture.sessionId, successor.snapshot.rootTurn.turnId);
    await tui.close();
    await fixture.stopHost(host);

    const chain = await fixture.readAdmissionChain();
    assert.deepEqual(
      chain.map((admission) => admission.turnId),
      [firstTurnId, successor.snapshot.rootTurn.turnId],
    );
    assert.deepEqual(chain[1]?.normalizedInput, followupContent);
  });
});

test('concurrent root admission for one Session has a single winner', async () => {
  await withExecutionRoot(async (fixture) => {
    const host = await fixture.startHost();
    const first = await connectClient(fixture.root, 'desktop');
    const second = await connectClient(fixture.root, 'tui');
    const turnIds = [randomUUID(), randomUUID()] as const;

    const outcomes = await Promise.allSettled([
      first.startTurn({
        sessionId: fixture.sessionId,
        turnId: turnIds[0],
        content: { text: FAKE_ASK_USER_QUESTION_PROMPT },
      }),
      second.startTurn({
        sessionId: fixture.sessionId,
        turnId: turnIds[1],
        content: { text: FAKE_ASK_USER_QUESTION_PROMPT },
      }),
    ]);
    const winners = outcomes.filter(
      (outcome): outcome is PromiseFulfilledResult<TurnSnapshot> => outcome.status === 'fulfilled',
    );
    const rejected = outcomes.filter(
      (outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected',
    );
    assert.equal(winners.length, 1);
    assert.equal(rejected.length, 1);
    assert.ok(rejected[0]?.reason instanceof RuntimeHostOperationError);
    assert.equal(rejected[0]?.reason.code, 'session_busy');

    const winner = winners[0]?.value;
    assert.ok(winner);
    await first.stopTurn({
      sessionId: fixture.sessionId,
      turnId: winner.turnId,
      runId: winner.runId,
    });
    await first.close();
    await second.close();
    await fixture.stopHost(host);

    const chain = await fixture.readAdmissionChain();
    assert.equal(chain.length, 1);
    assert.equal(chain[0]?.turnId, winner.turnId);
    assert.equal(chain[0]?.previousRootTurnId, null);
  });
});

test('an archived Session rejects a new Turn before durable admission', async () => {
  await withExecutionRoot(async (fixture) => {
    await fixture.archiveSession();
    const host = await fixture.startHost();
    const client = await connectClient(fixture.root, 'desktop');
    const turnId = randomUUID();

    await assert.rejects(
      () =>
        client.startTurn({
          sessionId: fixture.sessionId,
          turnId,
          content: { text: 'must not execute' },
        }),
      operationError('session_archived'),
    );
    assert.equal((await client.status()).state, 'ready');
    await client.close();
    await fixture.stopHost(host);

    assert.deepEqual(await fixture.readTurnFootprint(turnId), {
      admitted: false,
      runCount: 0,
      userMessageCount: 0,
    });
  });
});

test('a killed Host is recovered exactly once before its successor becomes ready', {
  skip: process.platform === 'win32' ? 'POSIX process death gate' : false,
}, async () => {
  await withExecutionRoot(async (fixture) => {
    const firstHost = await fixture.startHost();
    const first = await connectClient(fixture.root, 'desktop');
    const firstSubscription = await first.openSessionSubscription({
      sessionId: fixture.sessionId,
    });
    const firstProbe = new SubscriptionProbe(firstSubscription);
    const turnId = randomUUID();
    const started = await first.startTurn({
      sessionId: fixture.sessionId,
      turnId,
      content: { text: FAKE_ASK_USER_QUESTION_PROMPT },
    });
    await firstProbe.waitFor(
      (frame) =>
        frame.kind === 'subscription.session_projection' &&
        frame.snapshot.rootTurn?.runId === started.runId &&
        frame.snapshot.rootTurn.status !== 'admitted',
      'first Host did not publish the active root projection',
    );
    const pending = await waitForPendingInteraction(firstSubscription, firstProbe, started.runId);
    assert.equal(pending.sessionId, fixture.sessionId);
    assert.equal(pending.turnId, turnId);
    assert.equal(pending.runId, started.runId);
    const questionRequest = pending.request;
    assert.ok(questionRequest.kind === 'question');

    await fixture.killHost(firstHost);
    await first.closed;
    await firstProbe.waitForFailure('connection_closed');
    const secondHost = await fixture.startHost();
    const second = await connectClient(fixture.root, 'tui');
    const recoveredSubscription = await second.openSessionSubscription({
      sessionId: fixture.sessionId,
    });
    const recovered = await second.queryTurn({
      sessionId: fixture.sessionId,
      turnId,
    });
    assert.equal(recovered.status, 'failed');
    if (recovered.status === 'failed') assert.equal(recovered.failureClass, 'app_restarted');
    assert.notEqual(recoveredSubscription.hostEpoch, firstSubscription.hostEpoch);
    assert.equal(recoveredSubscription.snapshot.projectionRevision, 1);
    assert.deepEqual(recoveredSubscription.snapshot.rootTurn, recovered);
    assert.equal(recoveredSubscription.snapshot.queue.hostEpoch, recoveredSubscription.hostEpoch);
    assert.deepEqual(recoveredSubscription.snapshot.queue.steering, []);
    assert.deepEqual(recoveredSubscription.snapshot.queue.followup, []);
    const closed = await second.request('interaction.query', {
      sessionId: fixture.sessionId,
      interactionId: pending.interactionId,
    });
    assert.equal(closed.sessionId, fixture.sessionId);
    assert.equal(closed.turnId, turnId);
    assert.equal(closed.runId, started.runId);
    assert.equal(closed.status, 'closed');
    assert.equal(closed.outcome.kind, 'closure');
    if (closed.outcome.kind === 'closure') assert.equal(closed.outcome.reason, 'host_restarted');
    await assert.rejects(
      () =>
        second.request('interaction.answer', {
          interactionId: pending.interactionId,
          answer: {
            kind: 'question',
            answers: questionRequest.questions.map(() => null),
          },
        }),
      operationError('already_resolved'),
    );
    await recoveredSubscription.close();
    await second.close();
    await fixture.stopHost(secondHost);

    const thirdHost = await fixture.startHost();
    const third = await connectClient(fixture.root, 'run');
    const stable = await third.queryTurn({
      sessionId: fixture.sessionId,
      turnId,
    });
    assert.deepEqual(stable, recovered);
    assert.equal(stable.runId, started.runId);
    assert.deepEqual(
      await third.request('interaction.query', {
        sessionId: fixture.sessionId,
        interactionId: pending.interactionId,
      }),
      closed,
    );
    await third.close();
    await fixture.stopHost(thirdHost);

    const ledger = await fixture.readTurn(turnId);
    assert.equal(ledger.terminalEvents.length, 1);
    assert.equal(ledger.classification.kind, 'fact');
    if (ledger.classification.kind === 'fact') {
      assert.equal(ledger.classification.fact.failureClass, 'app_restarted');
    }
  });
});

test('graceful Host shutdown stops and drains an active Turn before releasing ownership', async () => {
  await withExecutionRoot(async (fixture) => {
    const host = await fixture.startHost();
    const client = await connectClient(fixture.root, 'desktop');
    const turnId = randomUUID();
    const started = await client.startTurn({
      sessionId: fixture.sessionId,
      turnId,
      content: { text: FAKE_ASK_USER_QUESTION_PROMPT },
    });

    const exit = await fixture.stopHost(host);
    assert.deepEqual(exit, { code: 0, signal: null });
    await client.closed;

    const successor = await fixture.startHost();
    const observer = await connectClient(fixture.root, 'tui');
    const stable = await observer.queryTurn({
      sessionId: fixture.sessionId,
      turnId,
    });
    assert.equal(stable.runId, started.runId);
    assert.equal(stable.status, 'cancelled');
    await observer.close();
    await fixture.stopHost(successor);

    const ledger = await fixture.readTurn(turnId);
    assert.equal(ledger.terminalEvents.length, 1);
    assert.equal(ledger.classification.kind, 'fact');
    if (ledger.classification.kind === 'fact') {
      assert.equal(ledger.classification.fact.runStatus, 'cancelled');
      assert.notEqual(ledger.classification.fact.failureClass, 'app_restarted');
    }
  });
});

test('a durable admission without a Run resumes before the Host becomes ready', async () => {
  await withExecutionRoot(async (fixture) => {
    const turnId = randomUUID();
    const quotes = quotedContent('recover pending admission');
    const { runId } = await fixture.seedAdmission(turnId, quotes);
    const host = await fixture.startHost();
    const client = await connectClient(fixture.root, 'tui');

    const recovered = await client.queryTurn({
      sessionId: fixture.sessionId,
      turnId,
    });
    assert.equal(recovered.runId, runId);
    assert.ok(recovered.status === 'running' || recovered.status === 'waiting_for_user');
    await assert.rejects(
      () =>
        client.startTurn({
          sessionId: fixture.sessionId,
          turnId: randomUUID(),
          content: { text: 'must remain behind the recovered admission' },
        }),
      operationError('session_busy'),
    );
    const stopped = await client.stopTurn(
      {
        sessionId: fixture.sessionId,
        turnId,
        runId,
      },
      PROCESS_TIMEOUT_MS,
    );
    assert.equal(stopped.status, 'cancelled');
    await client.close();
    await fixture.stopHost(host);

    const ledger = await fixture.readTurn(turnId);
    assert.equal(ledger.runs.length, 1);
    assert.equal(ledger.userMessages.length, 1);
    assert.deepEqual(ledger.userMessages[0]?.quotes, quotes.quotes);
    assert.deepEqual(userRuntimeContent(ledger.runtimeEvents)?.quotes, quotes.quotes);
    assert.equal(ledger.terminalEvents.length, 1);
    assert.equal(ledger.classification.kind, 'fact');
    if (ledger.classification.kind === 'fact') {
      assert.notEqual(ledger.classification.fact.failureClass, 'app_restarted');
    }
  });
});

test('startup recovery compares an existing quoted UserMessage canonically', async () => {
  await withExecutionRoot(async (fixture) => {
    const turnId = randomUUID();
    const content = quotedContent('recover existing message');
    const { runId, userMessageId } = await fixture.seedRunWithUserMessage(turnId, content);
    const host = await fixture.startHost();
    const client = await connectClient(fixture.root, 'tui');

    const recovered = await client.queryTurn({
      sessionId: fixture.sessionId,
      turnId,
    });
    assert.equal(recovered.runId, runId);
    assert.equal(recovered.status, 'failed');
    await client.close();
    await fixture.stopHost(host);

    const ledger = await fixture.readTurn(turnId);
    assert.equal(ledger.userMessages.length, 1);
    assert.equal(ledger.userMessages[0]?.id, userMessageId);
    assert.deepEqual(ledger.userMessages[0]?.quotes, content.quotes);
    assert.equal(ledger.terminalEvents.length, 1);
  });
});

test('startup recovery restores the admitted UserMessage before terminalizing its Run', async () => {
  await withExecutionRoot(async (fixture) => {
    const turnId = randomUUID();
    const { runId, userMessageId } = await fixture.seedRunWithoutUserMessage(
      turnId,
      'recover the admitted message',
    );
    const host = await fixture.startHost();
    const client = await connectClient(fixture.root, 'tui');

    const recovered = await client.queryTurn({
      sessionId: fixture.sessionId,
      turnId,
    });
    assert.equal(recovered.runId, runId);
    assert.equal(recovered.status, 'failed');
    if (recovered.status === 'failed') {
      assert.equal(recovered.failureClass, 'app_restarted');
    }
    await client.close();
    await fixture.stopHost(host);

    const ledger = await fixture.readTurn(turnId);
    assert.equal(ledger.runs.length, 1);
    assert.equal(ledger.userMessages.length, 1);
    assert.equal(ledger.userMessages[0]?.id, userMessageId);
    assert.equal(ledger.terminalEvents.length, 1);
  });
});

test('startup recovery canonically closes pending linked child admissions without inventing identity', async () => {
  await withExecutionRoot(async (fixture) => {
    const initial = await fixture.seedPendingChildAdmission('linked_child_initial');
    const resume = await fixture.seedPendingChildAdmission('linked_child_resume');
    const retry = await fixture.seedPendingChildAdmission('linked_child_provider_retry');
    const graph = await fixture.seedPendingChildAdmission('claimed_agent_graph_intent');

    const firstHost = await fixture.startHost();
    await fixture.stopHost(firstHost);
    const secondHost = await fixture.startHost();
    await fixture.stopHost(secondHost);

    const reader = await tryAcquireInteractiveRootReader(fixture.capability);
    assert.ok(reader);
    if (!reader) throw new Error('Unable to acquire recovery result reader');
    try {
      const stores = await openInteractiveExecutionStoresForRead(reader.lease);
      for (const recovered of [initial, resume, retry, graph]) {
        const run = await stores.agentRunStore.readRun(recovered.sessionId, recovered.runId);
        assert.equal(run.status, 'failed');
        assert.equal(run.failureClass, 'app_restarted');
        assert.equal(run.agentId, recovered.agentId);
        assert.equal(run.agentName, recovered.agentName);
        assert.equal(run.workspaceIdentity, undefined);
        if (recovered.kind === 'linked_child_resume') {
          assert.equal(run.resumedFromRunId, recovered.sourceRunId);
          assert.equal(run.retriedFromRunId, undefined);
        } else if (recovered.kind === 'linked_child_provider_retry') {
          assert.equal(run.retriedFromRunId, recovered.sourceRunId);
          assert.equal(run.resumedFromRunId, undefined);
        } else {
          assert.equal(run.resumedFromRunId, undefined);
          assert.equal(run.retriedFromRunId, undefined);
        }
        const runtimeEvents = await stores.runtimeEventStore.readImmutableRuntimeEvents(
          recovered.sessionId,
          recovered.runId,
        );
        const terminal = classifyTerminalRuntimeLedger(run, runtimeEvents);
        assert.equal(terminal.kind, 'fact');
        if (terminal.kind === 'fact') {
          assert.equal(terminal.fact.runStatus, 'failed');
          assert.equal(terminal.fact.failureClass, 'app_restarted');
        }
        const userMessages = (await stores.sessionStore.readMessages(recovered.sessionId)).filter(
          (message) => message.type === 'user' && message.turnId === recovered.turnId,
        );
        assert.equal(userMessages.length, recovered.kind === 'linked_child_provider_retry' ? 0 : 1);
        if (recovered.kind !== 'linked_child_provider_retry') {
          assert.equal(userMessages[0]?.id, recovered.userMessageId);
        }
      }
    } finally {
      await reader.close();
    }
  });
});

test('startup recovery rejects claimed graph Run lineage drift', async () => {
  await withExecutionRoot(async (fixture) => {
    await fixture.seedClaimedGraphRunLineageDrift();
    await fixture.expectHostStartupFailure();
    await fixture.assertOwnerAvailable();
  });
});

test('startup recovery imports past a truncated legacy RuntimeEvent tail without rewriting it', async () => {
  await withExecutionRoot(async (fixture) => {
    const turnId = randomUUID();
    const { runId } = await fixture.seedRunWithoutUserMessage(
      turnId,
      'recover after a partial RuntimeEvent write',
    );
    const runtimeEventsPath = fixture.runtimeEventsPath(runId);
    await mkdir(dirname(runtimeEventsPath), { recursive: true });
    await writeFile(runtimeEventsPath, '{"id":"truncated"', 'utf8');

    const host = await fixture.startHost();
    const client = await connectClient(fixture.root, 'tui');
    const recovered = await client.queryTurn({
      sessionId: fixture.sessionId,
      turnId,
    });
    assert.equal(recovered.status, 'failed');
    if (recovered.status === 'failed') {
      assert.equal(recovered.failureClass, 'app_restarted');
    }
    await client.close();
    await fixture.stopHost(host);

    assert.equal(await readFile(runtimeEventsPath, 'utf8'), '{"id":"truncated"');
    const ledger = await fixture.readTurn(turnId);
    assert.equal(ledger.terminalEvents.length, 1);
  });
});

test('startup recovery fails closed on a complete malformed RuntimeEvent record', async () => {
  await withExecutionRoot(async (fixture) => {
    const turnId = randomUUID();
    const { runId } = await fixture.seedRunWithoutUserMessage(
      turnId,
      'do not recover across durable corruption',
    );
    const runtimeEventsPath = fixture.runtimeEventsPath(runId);
    const malformed = '{"id":"malformed"\n';
    await mkdir(dirname(runtimeEventsPath), { recursive: true });
    await writeFile(runtimeEventsPath, malformed, 'utf8');

    await fixture.expectHostStartupFailure();
    assert.equal(await readFile(runtimeEventsPath, 'utf8'), malformed);
    await fixture.assertOwnerAvailable();
  });
});

test('startup recovery fails closed on a complete malformed Session record', async () => {
  await withExecutionRoot(async (fixture) => {
    await fixture.seedRunWithoutUserMessage(
      randomUUID(),
      'do not rewrite durable Session corruption',
    );
    const sessionPath = fixture.sessionPath();
    const malformed = '{"type":"user"\n';
    await appendFile(sessionPath, malformed, 'utf8');
    const expected = await readFile(sessionPath, 'utf8');

    await fixture.expectHostStartupFailure();
    assert.equal(await readFile(sessionPath, 'utf8'), expected);
    await fixture.assertOwnerAvailable();
  });
});

test('startup recovery fails closed on a complete malformed AgentRun record', async () => {
  await withExecutionRoot(async (fixture) => {
    const { runId } = await fixture.seedRunWithoutUserMessage(
      randomUUID(),
      'do not recover across durable AgentRun corruption',
    );
    const eventsPath = fixture.eventsPath(runId);
    const malformed = '{"type":"run_started"\n';
    await mkdir(dirname(eventsPath), { recursive: true });
    await writeFile(eventsPath, malformed, 'utf8');

    await fixture.expectHostStartupFailure();
    assert.equal(await readFile(eventsPath, 'utf8'), malformed);
    await fixture.assertOwnerAvailable();
  });
});

test('a pre-start durability failure rejects turn.start and drains the Host', {
  skip:
    process.platform === 'win32' || process.getuid?.() === 0 ? 'POSIX file-permission gate' : false,
}, async () => {
  await withExecutionRoot(async (fixture) => {
    const host = await fixture.startHost();
    const client = await connectClient(fixture.root, 'desktop');
    const turnId = randomUUID();
    const sessionPath = fixture.sessionPath();
    await chmod(sessionPath, 0o400);
    try {
      await assert.rejects(
        () =>
          client.startTurn({
            sessionId: fixture.sessionId,
            turnId,
            content: { text: 'fail before the durable start barrier' },
          }),
        operationError('internal_failure'),
      );
      await client.closed;
      await fixture.waitForHostExit(host);
    } finally {
      await chmod(sessionPath, 0o600);
    }

    const successor = await fixture.startHost();
    const observer = await connectClient(fixture.root, 'tui');
    const recovered = await observer.queryTurn({
      sessionId: fixture.sessionId,
      turnId,
    });
    assert.equal(recovered.status, 'failed');
    await observer.close();
    await fixture.stopHost(successor);

    const ledger = await fixture.readTurn(turnId);
    assert.equal(ledger.runs.length, 1);
    assert.equal(ledger.userMessages.length, 1);
    assert.equal(ledger.terminalEvents.length, 1);
  });
});

test('retry after a discarded turn.start response reuses the durable semantic admission', async () => {
  await withExecutionRoot(async (fixture) => {
    const host = await fixture.startHost();
    const turnId = randomUUID();
    const text = 'response loss must not duplicate this Turn';
    const dropped = await sendStartWithoutReadingResponse(host.endpoint, {
      sessionId: fixture.sessionId,
      turnId,
      text,
    });
    const observer = await connectClient(fixture.root, 'tui');
    const committed = await waitForTurn(observer, fixture.sessionId, turnId);
    dropped.destroy();

    const retried = await observer.startTurn({
      sessionId: fixture.sessionId,
      turnId,
      content: { text },
    });
    assert.equal(retried.runId, committed.runId);
    await assert.rejects(
      () =>
        observer.startTurn({
          sessionId: fixture.sessionId,
          turnId,
          content: { text: `${text} changed` },
        }),
      operationError('operation_conflict'),
    );
    const terminal = await waitForTerminalTurn(observer, fixture.sessionId, turnId);
    assert.equal(terminal.status, 'completed');
    await observer.close();

    await fixture.killHost(host);
    const successorHost = await fixture.startHost();
    const successorClient = await connectClient(fixture.root, 'run');
    assert.deepEqual(
      await successorClient.startTurn({
        sessionId: fixture.sessionId,
        turnId,
        content: { text },
      }),
      terminal,
    );
    const successorTurnId = randomUUID();
    await successorClient.startTurn({
      sessionId: fixture.sessionId,
      turnId: successorTurnId,
      content: { text: 'successor must extend the recovered durable tip' },
    });
    await waitForTerminalTurn(successorClient, fixture.sessionId, successorTurnId);
    await successorClient.close();
    await fixture.stopHost(successorHost);

    const ledger = await fixture.readTurn(turnId);
    assert.equal(ledger.runs.length, 1);
    assert.equal(ledger.userMessages.length, 1);
    assert.equal(ledger.terminalEvents.length, 1);
    const chain = await fixture.readAdmissionChain();
    assert.deepEqual(
      chain.map((admission) => admission.turnId),
      [turnId, successorTurnId],
    );
    assert.equal(chain[1]?.previousRootTurnId, turnId);
  });
});

test('a fresh quoted Turn preserves durable and Runtime handoff content', async () => {
  await withExecutionRoot(async (fixture) => {
    const host = await fixture.startHost();
    const client = await connectClient(fixture.root, 'desktop');
    const turnId = randomUUID();
    const content = quotedContent('fresh quoted turn');

    await client.startTurn({ sessionId: fixture.sessionId, turnId, content });
    await waitForTerminalTurn(client, fixture.sessionId, turnId);
    await client.close();
    await fixture.stopHost(host);

    const chain = await fixture.readAdmissionChain();
    assert.equal(chain.length, 1);
    assert.deepEqual(chain[0]?.normalizedInput, content);
    const ledger = await fixture.readTurn(turnId);
    assert.equal(ledger.userMessages.length, 1);
    assert.deepEqual(ledger.userMessages[0]?.quotes, content.quotes);
    assert.deepEqual(userRuntimeContent(ledger.runtimeEvents)?.quotes, content.quotes);
  });
});

test('same idle Message submit is connection-independent and starts one canonical root', async () => {
  await withExecutionRoot(async (fixture) => {
    const host = await fixture.startHost();
    const first = await connectClient(fixture.root, 'desktop');
    const second = await connectClient(fixture.root, 'tui');
    const messageId = randomUUID();
    const content = {
      text: '<context>canonical model input</context>',
      displayText: 'canonical display input',
      attachments: [attachment('idle-message', 'context.png')],
    };
    const input = {
      originHostEpoch: host.hostEpoch,
      sessionId: fixture.sessionId,
      messageId,
      content,
      placement: 'next_turn' as const,
    };

    const [firstResult, secondResult] = await Promise.all([
      first.request('turn.message.submit', input),
      second.request('turn.message.submit', input),
    ]);
    assert.deepEqual(secondResult, firstResult);
    assert.equal(firstResult.disposition, 'turn_started');
    if (firstResult.disposition !== 'turn_started') return;
    await waitForTerminalTurn(first, fixture.sessionId, firstResult.turnId);
    await first.close();
    await second.close();
    await fixture.stopHost(host);

    const chain = await fixture.readAdmissionChain();
    assert.equal(chain.length, 1);
    assert.deepEqual(chain[0]?.normalizedInput, content);
    assert.deepEqual(chain[0]?.sourceMessages, [
      { messageId, content, placement: 'next_turn', disposition: 'turn_started' },
    ]);
    const ledger = await fixture.readTurn(firstResult.turnId);
    assert.equal(ledger.runs.length, 1);
    assert.equal(ledger.userMessages.length, 1);
    assert.equal(ledger.userMessages[0]?.id, messageId);
    assert.equal(ledger.userMessages[0]?.text, content.text);
    assert.equal(ledger.userMessages[0]?.displayText, content.displayText);
    assert.deepEqual(ledger.userMessages[0]?.attachments, content.attachments);
  });
});

test('stale Session operations return not_found across the SQLite-backed UDS Host boundary', async () => {
  await withExecutionRoot(async (fixture) => {
    const host = await fixture.startHost();
    const client = await connectClient(fixture.root, 'desktop');
    const staleSessionId = randomUUID();
    try {
      await assert.rejects(
        () =>
          client.request('turn.message.submit', {
            originHostEpoch: host.hostEpoch,
            sessionId: staleSessionId,
            messageId: randomUUID(),
            content: { text: 'stale submit' },
            placement: 'next_turn',
          }),
        operationError('not_found'),
      );
      await assert.rejects(
        () =>
          client.request('turn.interrupt', {
            originHostEpoch: host.hostEpoch,
            sessionId: staleSessionId,
            interruptId: randomUUID(),
            turnId: randomUUID(),
            runId: randomUUID(),
          }),
        operationError('not_found'),
      );
      await assert.rejects(
        () =>
          client.startTurn({
            sessionId: staleSessionId,
            turnId: randomUUID(),
            content: { text: 'stale start' },
          }),
        operationError('not_found'),
      );
    } finally {
      await client.close();
      await fixture.stopHost(host);
    }
  });
});

test('steering becomes durable and ordered followups automatically start the next root', async () => {
  await withExecutionRoot(async (fixture) => {
    const host = await fixture.startHost();
    const first = await connectClient(fixture.root, 'desktop');
    const second = await connectClient(fixture.root, 'tui');
    const firstTurnId = randomUUID();
    await first.startTurn({
      sessionId: fixture.sessionId,
      turnId: firstTurnId,
      content: { text: FAKE_WAIT_FOR_STEERING_PROMPT },
    });
    const steeringId = randomUUID();
    const steeringContent = {
      text: '<steer>use the correction</steer>',
      displayText: 'use the correction',
      attachments: [attachment('steering', 'correction.png')],
    };
    const followupSources: Array<{ messageId: string; content: MessageContent }> = [
      {
        messageId: randomUUID(),
        content: {
          text: '<followup>first queued task</followup>',
          displayText: 'first queued task',
          attachments: [attachment('followup-first', 'first.png')],
          quotes: quoteRefs('followup-first'),
        },
      },
      {
        messageId: randomUUID(),
        content: {
          text: 'second queued task',
          quotes: [
            {
              text: 'second followup excerpt',
              sourceTurnId: 'turn-followup-second',
            },
          ],
        },
      },
    ];

    for (const source of followupSources) {
      assert.equal(
        (
          await second.request('turn.message.submit', {
            originHostEpoch: host.hostEpoch,
            sessionId: fixture.sessionId,
            ...source,
            placement: 'next_turn',
          })
        ).disposition,
        'followup',
      );
    }
    assert.equal(
      (
        await second.request('turn.message.submit', {
          originHostEpoch: host.hostEpoch,
          sessionId: fixture.sessionId,
          messageId: steeringId,
          content: steeringContent,
          placement: 'current_turn',
        })
      ).disposition,
      'steering',
    );

    assert.equal(
      (await waitForTerminalTurn(first, fixture.sessionId, firstTurnId)).status,
      'completed',
    );
    await waitForDurableMessageConflict(second, {
      originHostEpoch: 'previous-host-epoch',
      sessionId: fixture.sessionId,
      messageId: followupSources[0]!.messageId,
      content: { text: 'deliberately different durable identity probe' },
      placement: 'next_turn',
    });
    await first.close();
    await second.close();
    await fixture.stopHost(host);

    const firstLedger = await fixture.readTurn(firstTurnId);
    const steeringEvents = firstLedger.runtimeEvents.filter(
      (event) =>
        event.refs?.providerEventId === steeringId &&
        event.content?.kind === 'text' &&
        event.content.steering === true,
    );
    assert.equal(steeringEvents.length, 1);
    assert.equal(steeringEvents[0]?.content?.kind, 'text');
    if (steeringEvents[0]?.content?.kind === 'text') {
      const { kind: _kind, steering: _steering, ...durableContent } = steeringEvents[0].content;
      assert.deepEqual(durableContent, steeringContent);
    }

    const chain = await fixture.readAdmissionChain();
    assert.equal(chain.length, 2);
    assert.equal(chain[1]?.previousRootTurnId, firstTurnId);
    assert.deepEqual(
      chain[1]?.sourceMessages,
      followupSources.map((source) => ({
        ...source,
        placement: 'next_turn',
        disposition: 'followup',
      })),
    );
    assert.deepEqual(chain[1]?.normalizedInput, {
      text: `${followupSources[0].content.text}\n\n${followupSources[1].content.text}`,
      displayText: `${followupSources[0].content.displayText}\n\n${followupSources[1].content.text}`,
      attachments: followupSources[0].content.attachments,
      quotes: followupSources.flatMap((source) => source.content.quotes ?? []),
    });
    const followupTurnId = chain[1]?.turnId;
    assert.ok(followupTurnId);
    const followupLedger = await fixture.readTurn(followupTurnId);
    const expectedQuotes = followupSources.flatMap((source) => source.content.quotes ?? []);
    assert.equal(followupLedger.userMessages.length, 1);
    assert.deepEqual(followupLedger.userMessages[0]?.quotes, expectedQuotes);
    assert.deepEqual(userRuntimeContent(followupLedger.runtimeEvents)?.quotes, expectedQuotes);
  });
});

test('explicit retract is durable across connections and prevents successor admission', async () => {
  await withExecutionRoot(async (fixture) => {
    const host = await fixture.startHost();
    const first = await connectClient(fixture.root, 'desktop');
    const second = await connectClient(fixture.root, 'tui');
    const turnId = randomUUID();
    const started = await first.startTurn({
      sessionId: fixture.sessionId,
      turnId,
      content: { text: FAKE_ASK_USER_QUESTION_PROMPT },
    });
    const messageId = randomUUID();
    const submitted = await first.request('turn.message.submit', {
      originHostEpoch: host.hostEpoch,
      sessionId: fixture.sessionId,
      messageId,
      content: { text: 'withdraw before successor admission' },
      placement: 'next_turn',
    });
    assert.equal(submitted.disposition, 'followup');

    const retractInput = {
      originHostEpoch: host.hostEpoch,
      sessionId: fixture.sessionId,
      retractId: randomUUID(),
    };
    const retracted = await second.request('queue.retract', retractInput);
    assert.deepEqual(
      retracted.retracted.map((entry) => ({ messageId: entry.messageId, state: entry.state })),
      [{ messageId, state: 'retracted' }],
    );

    await second.close();
    const retrying = await connectClient(fixture.root, 'run');
    assert.deepEqual(await retrying.request('queue.retract', retractInput), retracted);

    const terminal = await first.stopTurn({
      sessionId: fixture.sessionId,
      turnId,
      runId: started.runId,
    });
    assert.equal(terminal.status, 'cancelled');
    await first.close();
    await retrying.close();
    await fixture.stopHost(host);

    const chain = await fixture.readAdmissionChain();
    assert.deepEqual(
      chain.map((admission) => admission.turnId),
      [turnId],
    );
  });
});

test('interrupt atomically retracts queued followup, stops the exact run, and is idempotent', async () => {
  await withExecutionRoot(async (fixture) => {
    const host = await fixture.startHost();
    const first = await connectClient(fixture.root, 'desktop');
    const second = await connectClient(fixture.root, 'tui');
    const turnId = randomUUID();
    const started = await first.startTurn({
      sessionId: fixture.sessionId,
      turnId,
      content: { text: FAKE_ASK_USER_QUESTION_PROMPT },
    });
    const followupId = randomUUID();
    const followupContent = {
      text: '<followup>must be withdrawn</followup>',
      displayText: 'must be withdrawn',
      attachments: [attachment('interrupt-followup', 'withdraw.png')],
    };
    await second.request('turn.message.submit', {
      originHostEpoch: host.hostEpoch,
      sessionId: fixture.sessionId,
      messageId: followupId,
      content: followupContent,
      placement: 'next_turn',
    });
    const interruptInput = {
      originHostEpoch: host.hostEpoch,
      sessionId: fixture.sessionId,
      interruptId: randomUUID(),
      turnId,
      runId: started.runId,
    };

    const [interrupted, concurrentRetry] = await Promise.all([
      first.request('turn.interrupt', interruptInput, PROCESS_TIMEOUT_MS),
      second.request('turn.interrupt', interruptInput, PROCESS_TIMEOUT_MS),
    ]);
    assert.deepEqual(concurrentRetry, interrupted);
    assert.deepEqual(
      await second.request('turn.interrupt', interruptInput, PROCESS_TIMEOUT_MS),
      interrupted,
    );
    assert.equal(interrupted.turn.turnId, turnId);
    assert.equal(interrupted.turn.runId, started.runId);
    assert.equal(interrupted.turn.status, 'cancelled');
    assert.equal(interrupted.retracted.length, 1);
    assert.ok(interrupted.retracted[0]?.entryId);
    assert.deepEqual(interrupted.retracted, [
      {
        entryId: interrupted.retracted[0]?.entryId,
        messageId: followupId,
        content: followupContent,
        placement: 'next_turn',
        state: 'retracted',
      },
    ]);
    await first.close();
    await second.close();
    await fixture.stopHost(host);

    const chain = await fixture.readAdmissionChain();
    assert.equal(chain.length, 1);
    assert.equal(chain[0]?.turnId, turnId);
  });
});

test('old-Epoch Message submit returns only exact durable outcomes', async () => {
  await withExecutionRoot(async (fixture) => {
    const firstHost = await fixture.startHost();
    const first = await connectClient(fixture.root, 'desktop');
    const rootMessageId = randomUUID();
    const rootContent = { text: `durable root ${'x'.repeat(360)}` };
    const rootResult = await first.request('turn.message.submit', {
      originHostEpoch: firstHost.hostEpoch,
      sessionId: fixture.sessionId,
      messageId: rootMessageId,
      content: rootContent,
      placement: 'next_turn',
    });
    assert.equal(rootResult.disposition, 'turn_started');
    if (rootResult.disposition !== 'turn_started') return;
    await waitForRunningTurn(first, fixture.sessionId, rootResult.turnId);
    const steeringId = randomUUID();
    const steeringContent = { text: 'durable steering proof' };
    await first.request('turn.message.submit', {
      originHostEpoch: firstHost.hostEpoch,
      sessionId: fixture.sessionId,
      messageId: steeringId,
      content: steeringContent,
      placement: 'current_turn',
    });
    await waitForTerminalTurn(first, fixture.sessionId, rootResult.turnId);
    await first.close();
    await fixture.stopHost(firstHost);

    const successorHost = await fixture.startHost();
    const successor = await connectClient(fixture.root, 'run');
    assert.deepEqual(
      await successor.request('turn.message.submit', {
        originHostEpoch: firstHost.hostEpoch,
        sessionId: fixture.sessionId,
        messageId: rootMessageId,
        content: rootContent,
        placement: 'next_turn',
      }),
      rootResult,
    );
    await assert.rejects(
      () =>
        successor.request('turn.message.submit', {
          originHostEpoch: firstHost.hostEpoch,
          sessionId: fixture.sessionId,
          messageId: steeringId,
          content: steeringContent,
          placement: 'current_turn',
        }),
      operationError('outcome_unknown'),
    );
    await assert.rejects(
      () =>
        successor.request('turn.message.submit', {
          originHostEpoch: firstHost.hostEpoch,
          sessionId: fixture.sessionId,
          messageId: randomUUID(),
          content: { text: 'no durable proof exists' },
          placement: 'next_turn',
        }),
      operationError('outcome_unknown'),
    );
    await successor.close();
    await fixture.stopHost(successorHost);
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
  try {
    const writer = await openInteractiveTaskLedgerStoreForWrite(owner.lease);
    const coordinator = new HostTaskLedgerCoordinator(writer, new SessionAdmissionGate());
    return await run(coordinator, buildTaskLedgerTools({ store: coordinator }));
  } finally {
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

interface ExecutionHostHandle {
  child: ChildProcess;
  hostEpoch: string;
  endpoint: string;
  recoveryOutcome?: RuntimeEvent;
}

interface TurnLedger {
  runs: AgentRunHeader[];
  userMessages: Array<Extract<StoredMessage, { type: 'user' }>>;
  runtimeEvents: RuntimeEvent[];
  terminalEvents: RuntimeEvent[];
  classification: ReturnType<typeof classifyTerminalRuntimeLedger>;
}

class ExecutionFixture {
  readonly #children = new Set<ChildProcess>();

  constructor(
    readonly base: string,
    readonly root: string,
    readonly capability: StorageRootCapability<'interactive'>,
    readonly sessionId: string,
  ) {}

  sessionPath(): string {
    return join(this.root, 'sessions', this.sessionId, 'session.jsonl');
  }

  runtimeEventsPath(runId: string): string {
    return join(this.root, 'sessions', this.sessionId, 'runs', runId, 'runtime-events.jsonl');
  }

  eventsPath(runId: string): string {
    return join(this.root, 'sessions', this.sessionId, 'runs', runId, 'events.jsonl');
  }

  async seedPendingChildAdmission(
    kind:
      | 'linked_child_initial'
      | 'linked_child_resume'
      | 'linked_child_provider_retry'
      | 'claimed_agent_graph_intent',
  ): Promise<{
    kind:
      | 'linked_child_initial'
      | 'linked_child_resume'
      | 'linked_child_provider_retry'
      | 'claimed_agent_graph_intent';
    sessionId: string;
    turnId: string;
    runId: string;
    sourceRunId: string | undefined;
    userMessageId: string | null;
    agentId: string;
    agentName: string;
  }> {
    const owner = await tryAcquireInteractiveRootOwner(this.capability);
    assert.ok(owner);
    if (!owner) throw new Error('Unable to acquire execution root for child admission setup');
    try {
      const stores = await openInteractiveExecutionStoresForWrite(owner.lease);
      const turnId = randomUUID();
      const runId = randomUUID();
      const sourceRunId =
        kind === 'linked_child_resume' || kind === 'linked_child_provider_retry'
          ? randomUUID()
          : undefined;
      const agentId = 'local-read';
      const agentName = 'Local Read';
      const child = await stores.sessionStore.createSubagent({
        cwd: this.root,
        name: `${agentName} ${kind}`,
        backend: 'fake',
        llmConnectionSlug: 'fake',
        model: 'fake-model',
        permissionMode: 'explore',
        collaborationMode: 'agent',
        orchestrationMode: 'default',
        subagentParent: {
          kind: 'subagent',
          parentSessionId: this.sessionId,
          spawnedBy: {
            parentRunId: `parent-${kind}`,
            parentTurnId: `parent-turn-${kind}`,
            toolCallId: `tool-${kind}`,
          },
          lifecycle: 'foreground',
        },
        subagentRuntime: {
          schemaVersion: 1,
          definitionVersion: 1,
          agentId,
          agentName,
          profile: 'local_read',
          systemPrompt: 'Read the assigned workspace task.',
          toolNames: ['Read', 'Glob', 'Grep'],
          categoryPolicy: { read: 'allow' },
          permissionCeiling: 'ask',
        },
        subagentSpawn: {
          schemaVersion: 1,
          requestFingerprint: (kind === 'linked_child_initial'
            ? 'a'
            : kind === 'linked_child_resume'
              ? 'b'
              : kind === 'linked_child_provider_retry'
                ? 'c'
                : 'd'
          ).repeat(64),
          initialTurnId:
            kind === 'linked_child_initial' || kind === 'claimed_agent_graph_intent'
              ? turnId
              : `initial-${kind}`,
          initialRunId:
            kind === 'linked_child_initial' || kind === 'claimed_agent_graph_intent'
              ? runId
              : sourceRunId!,
        },
      });
      assert.equal(child.created, true);
      if (sourceRunId) {
        const sourceTs = Date.now();
        const sourceRun: AgentRunHeader = {
          runId: sourceRunId,
          invocationId: sourceRunId,
          sessionId: child.header.id,
          turnId: `source-turn-${kind}`,
          status: 'created',
          backendKind: 'fake',
          llmConnectionSlug: 'fake',
          modelId: 'fake-model',
          cwd: this.root,
          permissionMode: 'explore',
          collaborationMode: 'agent',
          createdAt: sourceTs,
          updatedAt: sourceTs,
          agentId,
          agentName,
        };
        await stores.agentRunStore.createRun(sourceRun, { durable: true });
        const sourceTerminal = buildRecoveredTerminalRuntimeEvent({
          id: randomUUID(),
          run: sourceRun,
          status: 'failed',
          ts: sourceTs,
          failureClass: kind === 'linked_child_provider_retry' ? 'RateLimit' : 'source_failed',
          recoveryReason: 'test_source_terminal',
        });
        await commitTerminalRunWithRuntimeFact({
          runStore: stores.agentRunStore,
          runtimeEventStore: stores.runtimeEventStore,
          newId: randomUUID,
          sessionId: child.header.id,
          runId: sourceRunId,
          turnId: sourceRun.turnId,
          status: 'failed',
          ts: sourceTs,
          terminalEvent: sourceTerminal,
          failureClass: kind === 'linked_child_provider_retry' ? 'RateLimit' : 'source_failed',
        });
      }
      const userMessageId = kind === 'linked_child_provider_retry' ? null : randomUUID();
      const admitted = await stores.agentRunStore.admitRootTurn({
        sessionId: child.header.id,
        turnId,
        proposedRunId: runId,
        proposedUserMessageId: userMessageId,
        execution:
          kind === 'linked_child_initial'
            ? { kind, agentId, agentName }
            : kind === 'claimed_agent_graph_intent'
              ? {
                  kind,
                  claim: {
                    schemaVersion: 1,
                    claimId: `graph_claim_${'a'.repeat(32)}`,
                    graphId: `graph-${runId}`,
                    intentId: `graph_intent_${'b'.repeat(32)}`,
                    intentFingerprint: `sha256:${'c'.repeat(64)}`,
                    readinessContextFingerprint: `sha256:${'d'.repeat(64)}`,
                    targetOperatorId: 'local-read',
                    targetSessionId: child.header.id,
                    targetTurnId: turnId,
                    targetRunId: runId,
                    claimedAt: Date.now(),
                  },
                  agentId,
                  agentName,
                }
              : { kind, agentId, agentName, sourceRunId: sourceRunId! },
        previousRootTurnId: null,
        normalizedInput: { text: `pending ${kind}` },
        sourceMessages: [],
        admittedAt: Date.now(),
      });
      assert.equal(admitted.kind, 'admitted');
      return {
        kind,
        sessionId: child.header.id,
        turnId,
        runId,
        sourceRunId,
        userMessageId,
        agentId,
        agentName,
      };
    } finally {
      await owner.close();
    }
  }

  async seedClaimedGraphRunLineageDrift(): Promise<void> {
    const graph = await this.seedPendingChildAdmission('claimed_agent_graph_intent');
    const owner = await tryAcquireInteractiveRootOwner(this.capability);
    assert.ok(owner);
    if (!owner) throw new Error('Unable to acquire execution root for graph lineage setup');
    try {
      const stores = await openInteractiveExecutionStoresForWrite(owner.lease);
      const ts = Date.now();
      await stores.agentRunStore.createRun(
        {
          runId: graph.runId,
          invocationId: graph.runId,
          sessionId: graph.sessionId,
          turnId: graph.turnId,
          status: 'created',
          backendKind: 'fake',
          llmConnectionSlug: 'fake',
          modelId: 'fake-model',
          cwd: this.root,
          permissionMode: 'explore',
          collaborationMode: 'agent',
          createdAt: ts,
          updatedAt: ts,
          resumedFromRunId: randomUUID(),
          agentId: graph.agentId,
          agentName: graph.agentName,
        },
        { durable: true },
      );
    } finally {
      await owner.close();
    }
  }

  seedAdmission(
    turnId: string,
    content: string | MessageContent,
  ): Promise<{ runId: string; userMessageId: string }> {
    return this.seedTurnState(turnId, content, false, false);
  }

  async archiveSession(): Promise<void> {
    const owner = await tryAcquireInteractiveRootOwner(this.capability);
    assert.ok(owner);
    if (!owner) throw new Error('Unable to acquire execution root for archive');
    try {
      const stores = await openInteractiveExecutionStoresForWrite(owner.lease);
      await stores.sessionStore.archive(this.sessionId);
    } finally {
      await owner.close();
    }
  }

  async seedConnectionEffect(baseUrl: string, secret: string): Promise<ConnectionCatalogEntry> {
    const owner = await tryAcquireInteractiveRootOwner(this.capability);
    assert.ok(owner);
    if (!owner) throw new Error('Unable to acquire execution root for connection effect setup');
    try {
      const stores = await openInteractiveRuntimePolicyStoresForWrite(owner.lease);
      const current = await stores.connectionCatalog.getSnapshot();
      const created = await stores.connectionCatalog.create({
        expectedCatalogRevision: current.revision,
        connection: {
          slug: 'connection-effect-provider',
          name: 'Connection effect provider',
          providerType: 'moonshot',
          baseUrl,
          enabled: true,
          enabledModelIds: [CONNECTION_EFFECT_MODEL_IDS[0]!],
        },
      });
      assert.equal(created.kind, 'committed');
      if (created.kind !== 'committed') {
        throw new Error('Connection effect setup did not create a connection');
      }
      const connection = created.snapshot.connections.find(
        ({ slug }) => slug === 'connection-effect-provider',
      );
      assert.ok(connection);
      if (!connection) throw new Error('Connection effect setup omitted its connection');
      const credential = await stores.credentialVault.set({
        locator: {
          scope: 'connection',
          connectionId: connection.connectionId,
          kind: 'api_key',
        },
        expected: null,
        secret,
      });
      assert.equal(credential.kind, 'committed');
      return connection;
    } finally {
      await owner.close();
    }
  }

  seedRunWithoutUserMessage(
    turnId: string,
    content: string | MessageContent,
  ): Promise<{ runId: string; userMessageId: string }> {
    return this.seedTurnState(turnId, content, true, false);
  }

  seedRunWithUserMessage(
    turnId: string,
    content: MessageContent,
  ): Promise<{ runId: string; userMessageId: string }> {
    return this.seedTurnState(turnId, content, true, true);
  }

  private async seedTurnState(
    turnId: string,
    input: string | MessageContent,
    createRun: boolean,
    createUserMessage: boolean,
  ): Promise<{ runId: string; userMessageId: string }> {
    const owner = await tryAcquireInteractiveRootOwner(this.capability);
    assert.ok(owner);
    if (!owner) throw new Error('Unable to acquire execution root for admission setup');
    try {
      const stores = await openInteractiveExecutionStoresForWrite(owner.lease);
      const admittedAt = Date.now();
      const content = typeof input === 'string' ? { text: input } : input;
      const result = await stores.agentRunStore.admitRootTurn({
        sessionId: this.sessionId,
        turnId,
        proposedRunId: randomUUID(),
        proposedUserMessageId: randomUUID(),
        execution: { kind: 'external_message' },
        previousRootTurnId: null,
        normalizedInput: content,
        sourceMessages: [],
        admittedAt,
      });
      assert.equal(result.kind, 'admitted');
      if (createRun) {
        await stores.agentRunStore.createRun({
          runId: result.admission.runId,
          invocationId: result.admission.runId,
          sessionId: this.sessionId,
          turnId,
          status: 'created',
          backendKind: 'fake',
          llmConnectionSlug: 'fake',
          modelId: 'fake-model',
          cwd: this.root,
          permissionMode: 'ask',
          createdAt: admittedAt,
          updatedAt: admittedAt,
        });
      }
      assert.ok(result.admission.userMessageId);
      if (createUserMessage) {
        await stores.sessionStore.appendMessage(this.sessionId, {
          type: 'user',
          id: result.admission.userMessageId,
          turnId,
          ts: admittedAt,
          ...content,
        });
      }
      return {
        runId: result.admission.runId,
        userMessageId: result.admission.userMessageId,
      };
    } finally {
      await owner.close();
    }
  }

  async startHost(recoveryProbe?: {
    sessionId: string;
    runId: string;
  }): Promise<ExecutionHostHandle> {
    const child = this.spawnHost('inherit', recoveryProbe);
    const ready = await waitForHostReady(child);
    return { child, ...ready };
  }

  async expectHostStartupFailure(): Promise<void> {
    const child = this.spawnHost('ignore');
    await assert.rejects(() => waitForHostReady(child), /execution Host exited before readiness/);
    await withTimeout(waitForExit(child), PROCESS_TIMEOUT_MS, 'failed execution Host did not exit');
    this.#children.delete(child);
  }

  async assertOwnerAvailable(): Promise<void> {
    const owner = await tryAcquireInteractiveRootOwner(this.capability);
    assert.ok(owner);
    await owner?.close();
  }

  async stopHost(
    host: ExecutionHostHandle,
  ): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
    if (host.child.exitCode === null && host.child.signalCode === null) {
      host.child.kill('SIGTERM');
    }
    const exit = await withTimeout(
      waitForExitResult(host.child),
      PROCESS_TIMEOUT_MS + 2_000,
      'execution Host did not stop',
    );
    this.#children.delete(host.child);
    if (exit.code !== 0 || exit.signal !== null) {
      throw new Error(
        `execution Host stopped uncleanly: ${exit.code === null ? exit.signal : `code ${exit.code}`}`,
      );
    }
    return exit;
  }

  async killHost(host: ExecutionHostHandle): Promise<void> {
    host.child.kill('SIGKILL');
    await withTimeout(
      waitForExit(host.child),
      PROCESS_TIMEOUT_MS,
      'execution Host survived SIGKILL',
    );
    this.#children.delete(host.child);
  }

  async waitForHostExit(host: ExecutionHostHandle): Promise<void> {
    await withTimeout(
      waitForExit(host.child),
      PROCESS_TIMEOUT_MS,
      'draining execution Host did not exit',
    );
    this.#children.delete(host.child);
  }

  async readTurn(turnId: string): Promise<TurnLedger> {
    const reader = await acquireReader(this.capability);
    try {
      const stores = await openInteractiveExecutionStoresForRead(reader.lease);
      const admission = await stores.agentRunStore.readRootTurnAdmission(this.sessionId, turnId);
      assert.ok(admission);
      const runs = (await stores.agentRunStore.listSessionRuns(this.sessionId)).filter(
        (candidate) => candidate.turnId === turnId,
      );
      const run = await stores.agentRunStore.readRun(this.sessionId, admission.runId);
      const messages = await stores.sessionStore.readMessages(this.sessionId);
      const runtimeEvents = await stores.runtimeEventStore.readImmutableRuntimeEvents(
        this.sessionId,
        admission.runId,
      );
      return {
        runs,
        userMessages: messages.filter(
          (message): message is Extract<StoredMessage, { type: 'user' }> =>
            message.type === 'user' && message.turnId === turnId,
        ),
        runtimeEvents,
        terminalEvents: runtimeEvents.filter(isTerminalRuntimeEvent),
        classification: classifyTerminalRuntimeLedger(run, runtimeEvents),
      };
    } finally {
      await reader.close();
    }
  }

  async readAdmissionChain() {
    const owner = await tryAcquireInteractiveRootOwner(this.capability);
    assert.ok(owner);
    if (!owner) throw new Error('Unable to acquire execution root for admission inspection');
    try {
      const stores = await openInteractiveExecutionStoresForWrite(owner.lease);
      return stores.agentRunStore.listRootTurnAdmissionsForRecovery(this.sessionId);
    } finally {
      await owner.close();
    }
  }

  async readTurnFootprint(turnId: string): Promise<{
    admitted: boolean;
    runCount: number;
    userMessageCount: number;
  }> {
    const reader = await acquireReader(this.capability);
    try {
      const stores = await openInteractiveExecutionStoresForRead(reader.lease);
      const [admission, runs, messages] = await Promise.all([
        stores.agentRunStore.readRootTurnAdmission(this.sessionId, turnId),
        stores.agentRunStore.listSessionRuns(this.sessionId),
        stores.sessionStore.readMessages(this.sessionId),
      ]);
      return {
        admitted: admission !== undefined,
        runCount: runs.filter((run) => run.turnId === turnId).length,
        userMessageCount: messages.filter(
          (message) => message.type === 'user' && message.turnId === turnId,
        ).length,
      };
    } finally {
      await reader.close();
    }
  }

  async close(): Promise<void> {
    for (const child of this.#children) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await withTimeout(waitForExit(child), 1_000, 'cleanup Host did not exit').catch(
        () => undefined,
      );
    }
    await rm(join(resolveRootControlNamespace(), this.capability.rootId), {
      recursive: true,
      force: true,
    });
    await removePosixEndpointDirectories(this.capability.rootId);
    await rm(this.base, { recursive: true, force: true });
  }

  private spawnHost(
    stderr: 'inherit' | 'ignore',
    recoveryProbe?: { sessionId: string; runId: string },
  ): ChildProcess {
    const child = fork(
      new URL('./fixtures/execution-host.js', import.meta.url),
      [
        this.root,
        this.capability.rootId,
        '60000',
        ...(recoveryProbe ? [recoveryProbe.sessionId, recoveryProbe.runId] : []),
      ],
      { stdio: ['ignore', 'ignore', stderr, 'ipc'] },
    );
    this.#children.add(child);
    return child;
  }
}

async function withExecutionRoot(run: (fixture: ExecutionFixture) => Promise<void>): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), 'maka-runtime-host-execution-'));
  const root = join(base, 'root');
  const capability = await resolveStorageRoot({
    path: root,
    kind: 'interactive',
  });
  const owner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(owner);
  let sessionId: string;
  try {
    const stores = await openInteractiveExecutionStoresForWrite(owner.lease);
    const session = await stores.sessionStore.create({
      cwd: root,
      backend: 'fake',
      llmConnectionSlug: 'fake',
      model: 'fake-model',
      permissionMode: 'ask',
    });
    sessionId = session.id;
  } finally {
    await owner.close();
  }
  const fixture = new ExecutionFixture(base, root, capability, sessionId);
  try {
    await run(fixture);
  } finally {
    await fixture.close();
  }
}

async function connectClient(
  rootPath: string,
  surface: 'desktop' | 'tui' | 'run',
): Promise<RuntimeHostConnection> {
  const result = await connectRuntimeHost({
    rootPath,
    surface,
    protocol: CURRENT_PROTOCOL,
  });
  assert.equal(result.kind, 'connected');
  return result.connection;
}

async function startConnectionEffectProvider(options: { responseDelayMs?: number } = {}): Promise<{
  readonly baseUrl: string;
  readonly requests: Array<{
    readonly method: string;
    readonly url: string;
    readonly authorization: string | undefined;
  }>;
  close(): Promise<void>;
}> {
  const requests: Array<{
    method: string;
    url: string;
    authorization: string | undefined;
  }> = [];
  const server = createServer((request, response) => {
    requests.push({
      method: request.method ?? '',
      url: request.url ?? '',
      authorization: request.headers.authorization,
    });
    const respond = () => {
      response.statusCode = 200;
      response.setHeader('content-type', 'application/json');
      response.end(
        request.method === 'GET'
          ? JSON.stringify({ data: CONNECTION_EFFECT_MODEL_IDS.map((id) => ({ id })) })
          : JSON.stringify({ choices: [] }),
      );
    };
    const responseDelayMs = options.responseDelayMs ?? 0;
    if (responseDelayMs > 0) {
      setTimeout(respond, responseDelayMs);
    } else {
      respond();
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    await closeHttpServer(server);
    throw new Error('Connection effect provider did not bind a TCP address');
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    close: () => closeHttpServer(server),
  };
}

function closeHttpServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function sendStartWithoutReadingResponse(
  endpoint: string,
  input: { sessionId: string; turnId: string; text: string },
): Promise<FramedTransport> {
  const transport = new FramedTransport(await openSocket(endpoint));
  await transport.write({
    kind: 'hello',
    clientInstanceId: randomUUID(),
    surface: 'desktop',
    protocolMin: CURRENT_PROTOCOL.min,
    protocolMax: CURRENT_PROTOCOL.max,
  });
  const handshake = decodeHostFrame(await transport.read(2_000));
  assert.ok('kind' in handshake);
  assert.equal(handshake.kind, 'accepted');
  await transport.write({
    requestId: randomUUID(),
    operation: 'turn.start',
    input: {
      sessionId: input.sessionId,
      turnId: input.turnId,
      content: { text: input.text },
    },
  });
  return transport;
}

function openSocket(path: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect(path);
    const onError = (error: Error) => {
      socket.off('connect', onConnect);
      reject(error);
    };
    const onConnect = () => {
      socket.off('error', onError);
      resolve(socket);
    };
    socket.once('error', onError);
    socket.once('connect', onConnect);
  });
}

async function waitForTurn(
  connection: RuntimeHostConnection,
  sessionId: string,
  turnId: string,
): Promise<TurnSnapshot> {
  const deadline = Date.now() + PROCESS_TIMEOUT_MS;
  while (true) {
    try {
      return await connection.queryTurn({ sessionId, turnId });
    } catch (error) {
      if (!(error instanceof RuntimeHostOperationError) || error.code !== 'not_found') throw error;
      if (Date.now() >= deadline) throw new Error('Turn admission was not observed');
      await sleep(20);
    }
  }
}

class SubscriptionProbe {
  readonly frames: SubscriptionFrame[] = [];
  readonly done: Promise<void>;
  #failure: unknown;
  #settled = false;

  constructor(subscription: RuntimeHostSessionSubscription) {
    this.done = this.#consume(subscription);
  }

  async waitFor(
    predicate: (frame: SubscriptionFrame) => boolean,
    message: string,
  ): Promise<SubscriptionFrame> {
    const deadline = Date.now() + PROCESS_TIMEOUT_MS;
    while (true) {
      const frame = this.frames.find(predicate);
      if (frame) return frame;
      if (this.#failure) throw this.#failure;
      if (this.#settled) throw new Error(`${message}: subscription closed`);
      if (Date.now() >= deadline) throw new Error(message);
      await sleep(10);
    }
  }

  async waitForFailure(reason: RuntimeHostSubscriptionError['reason']): Promise<void> {
    const deadline = Date.now() + PROCESS_TIMEOUT_MS;
    while (!this.#failure && !this.#settled && Date.now() < deadline) await sleep(10);
    assert.ok(this.#failure instanceof RuntimeHostSubscriptionError);
    assert.equal(this.#failure.reason, reason);
  }

  indexOf(frame: SubscriptionFrame): number {
    return this.frames.indexOf(frame);
  }

  async #consume(subscription: RuntimeHostSessionSubscription): Promise<void> {
    try {
      for await (const frame of subscription) this.frames.push(frame);
    } catch (error) {
      this.#failure = error;
    } finally {
      this.#settled = true;
    }
  }
}

async function waitForPendingInteraction(
  subscription: RuntimeHostSessionSubscription,
  probe: SubscriptionProbe,
  runId: string,
): Promise<InteractionPendingSnapshot> {
  const initial = subscription.snapshot.interactions.pending.find(
    (interaction) => interaction.runId === runId,
  );
  if (initial) return initial;
  const frame = await probe.waitFor(
    (candidate) =>
      candidate.kind === 'subscription.session_projection' &&
      candidate.snapshot.interactions.pending.some((interaction) => interaction.runId === runId),
    'subscription did not publish the pending Interaction',
  );
  assert.equal(frame.kind, 'subscription.session_projection');
  const pending = frame.snapshot.interactions.pending.find(
    (interaction) => interaction.runId === runId,
  );
  assert.ok(pending);
  return pending;
}

async function waitForTerminalTurn(
  connection: RuntimeHostConnection,
  sessionId: string,
  turnId: string,
): Promise<TurnSnapshot> {
  const deadline = Date.now() + PROCESS_TIMEOUT_MS;
  while (true) {
    const snapshot = await connection.queryTurn({ sessionId, turnId });
    if (
      snapshot.status === 'completed' ||
      snapshot.status === 'failed' ||
      snapshot.status === 'cancelled'
    ) {
      return snapshot;
    }
    if (Date.now() >= deadline) throw new Error('Turn did not reach a terminal fact');
    await sleep(20);
  }
}

async function waitForRunningTurn(
  connection: RuntimeHostConnection,
  sessionId: string,
  turnId: string,
): Promise<TurnSnapshot> {
  const deadline = Date.now() + PROCESS_TIMEOUT_MS;
  while (true) {
    const snapshot = await connection.queryTurn({ sessionId, turnId });
    if (snapshot.status === 'running' || snapshot.status === 'waiting_for_user') return snapshot;
    if (Date.now() >= deadline) throw new Error('Turn did not become active');
    await sleep(20);
  }
}

async function waitForDurableMessageConflict(
  connection: RuntimeHostConnection,
  input: TurnMessageSubmitInput,
): Promise<void> {
  const deadline = Date.now() + PROCESS_TIMEOUT_MS;
  while (true) {
    try {
      await connection.request('turn.message.submit', input);
      throw new Error('Conflicting durable Message identity was accepted');
    } catch (error) {
      if (error instanceof RuntimeHostOperationError && error.code === 'operation_conflict') return;
      if (!(error instanceof RuntimeHostOperationError) || error.code !== 'outcome_unknown') {
        throw error;
      }
    }
    if (Date.now() >= deadline) throw new Error('Durable Message source was not observed');
    await sleep(20);
  }
}

function operationError(code: RuntimeHostOperationError['code']) {
  return (error: unknown): boolean =>
    error instanceof RuntimeHostOperationError && error.code === code;
}

function assertJsonLines(bytes: string): void {
  for (const line of bytes.split('\n').filter(Boolean)) {
    assert.doesNotThrow(() => JSON.parse(line));
  }
}

function attachment(id: string, name: string) {
  return {
    kind: 'image' as const,
    name,
    mimeType: 'image/png',
    bytes: 10,
    ref: { kind: 'workspace_file' as const, relativePath: `attachments/${id}.png` },
  };
}

function quoteRefs(prefix: string) {
  return [
    {
      text: `${prefix} first excerpt`,
      label: 'Assistant',
      sourceTurnId: `turn-${prefix}-1`,
    },
    {
      text: `${prefix} second excerpt`,
      sourceTurnId: `turn-${prefix}-2`,
    },
  ];
}

function quotedContent(text: string): MessageContent {
  return { text, quotes: quoteRefs(text.replaceAll(' ', '-')) };
}

function userRuntimeContent(
  events: readonly RuntimeEvent[],
): Extract<NonNullable<RuntimeEvent['content']>, { kind: 'text' }> | undefined {
  for (const event of events) {
    if (event.role === 'user' && event.content?.kind === 'text') return event.content;
  }
  return undefined;
}

function waitForHostReady(
  child: ChildProcess,
): Promise<{ hostEpoch: string; endpoint: string; recoveryOutcome?: RuntimeEvent }> {
  return withTimeout(
    new Promise((resolve, reject) => {
      const cleanup = () => {
        child.off('error', onError);
        child.off('exit', onExit);
        child.off('message', onMessage);
      };
      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };
      const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
        cleanup();
        reject(new Error(`execution Host exited before readiness: ${code ?? signal}`));
      };
      const onMessage = (message: unknown) => {
        if (!isHostReadyMessage(message)) return;
        cleanup();
        resolve({
          hostEpoch: message.hostEpoch,
          endpoint: message.endpoint,
          ...(message.recoveryOutcome ? { recoveryOutcome: message.recoveryOutcome } : {}),
        });
      };
      child.once('error', onError);
      child.once('exit', onExit);
      child.on('message', onMessage);
    }),
    PROCESS_TIMEOUT_MS,
    'execution Host did not become ready',
  );
}

function isHostReadyMessage(value: unknown): value is {
  type: 'ready';
  hostEpoch: string;
  endpoint: string;
  recoveryOutcome?: RuntimeEvent;
} {
  if (!value || typeof value !== 'object') return false;
  const message = value as Record<string, unknown>;
  return (
    message.type === 'ready' &&
    typeof message.hostEpoch === 'string' &&
    typeof message.endpoint === 'string' &&
    (message.recoveryOutcome === undefined ||
      (typeof message.recoveryOutcome === 'object' && message.recoveryOutcome !== null))
  );
}

function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', () => resolve());
  });
}

function waitForExitResult(
  child: ChildProcess,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      child.off('error', onError);
      child.off('exit', onExit);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      resolve({ code, signal });
    };
    child.once('error', onError);
    child.once('exit', onExit);
  });
}

async function acquireReader(capability: StorageRootCapability<'interactive'>) {
  const deadline = Date.now() + PROCESS_TIMEOUT_MS;
  while (true) {
    const reader = await tryAcquireInteractiveRootReader(capability);
    if (reader) return reader;
    if (Date.now() >= deadline)
      throw new Error('Interactive root reader could not acquire the released root');
    await sleep(20);
  }
}

async function removePosixEndpointDirectories(rootId: string): Promise<void> {
  if (process.platform === 'win32' || typeof process.getuid !== 'function') return;
  const prefix = `m-${process.getuid()}-${Buffer.from(rootId, 'hex').toString('base64url')}-`;
  const entries = await readdir('/tmp', { withFileTypes: true });
  await Promise.all(
    entries.map(async (entry) => {
      if (entry.isDirectory() && entry.name.startsWith(prefix)) {
        await rm(join('/tmp', entry.name), { recursive: true, force: true });
      }
    }),
  );
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<T>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
