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
import type { StoredMessage } from '@maka/core/session';
import type { Task } from '@maka/core/task-ledger';
import { isTerminalRuntimeEvent } from '@maka/core/runtime-event';
import type { RuntimeEvent } from '@maka/core/runtime-event';
import { buildTaskLedgerTools } from '@maka/runtime/task-ledger-tools';
import {
  buildRecoveredTerminalRuntimeEvent,
  classifyTerminalRuntimeLedger,
  commitTerminalRunWithRuntimeFact,
} from '@maka/runtime/terminal-run-commit';
import {
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
  type TurnStartResult,
} from '../protocol/index.js';
import { SessionAdmissionGate } from '../server/session-admission-gate.js';
import { HostTaskLedgerCoordinator } from '../server/task-ledger-coordinator.js';
import { FramedTransport } from '../transport/framed-transport.js';

import {
  CONNECTION_EFFECT_MODEL_IDS,
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

test('subscribed Clients share one canonical queue and ordered root handoff', async () => {
  await withExecutionRoot(async (fixture) => {
    const host = await fixture.startHost();
    const desktop = await connectClient(fixture.root, 'desktop');
    const tui = await connectClient(fixture.root, 'tui');
    const desktopSubscription = await desktop.openSessionSubscription({
      sessionId: fixture.sessionId,
      transcript: { kind: 'none' },
    });
    const tuiSubscription = await tui.openSessionSubscription({
      sessionId: fixture.sessionId,
      transcript: { kind: 'none' },
    });
    const desktopProbe = new SubscriptionProbe(desktopSubscription);
    const tuiProbe = new SubscriptionProbe(tuiSubscription);
    for (const subscription of [desktopSubscription, tuiSubscription]) {
      assert.equal(subscription.hostEpoch, host.hostEpoch);
      assert.equal(subscription.snapshot.rootTurn, null);
      assert.equal(subscription.snapshot.projectionRevision, 1);
      assert.equal(subscription.snapshot.queue.hostEpoch, host.hostEpoch);
    }

    const firstTurnId = randomUUID();
    const started = requireStartedTurn(
      await desktop.startTurn({
        sessionId: fixture.sessionId,
        turnId: firstTurnId,
        content: { text: `continuity root ${'x'.repeat(540)}` },
      }),
    );
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
      (outcome): outcome is PromiseFulfilledResult<TurnStartResult> =>
        outcome.status === 'fulfilled',
    );
    const rejected = outcomes.filter(
      (outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected',
    );
    assert.equal(winners.length, 1);
    assert.equal(rejected.length, 1);
    assert.ok(rejected[0]?.reason instanceof RuntimeHostOperationError);
    assert.equal(rejected[0]?.reason.code, 'session_busy');

    const winnerResult = winners[0]?.value;
    assert.ok(winnerResult);
    const winner = requireStartedTurn(winnerResult);
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

test('a killed Host is recovered exactly once before its successor becomes ready', async () => {
  await withExecutionRoot(async (fixture) => {
    const firstHost = await fixture.startHost();
    const first = await connectClient(fixture.root, 'desktop');
    const firstSubscription = await first.openSessionSubscription({
      sessionId: fixture.sessionId,
      transcript: { kind: 'none' },
    });
    const firstProbe = new SubscriptionProbe(firstSubscription);
    const turnId = randomUUID();
    const started = requireStartedTurn(
      await first.startTurn({
        sessionId: fixture.sessionId,
        turnId,
        content: { text: FAKE_ASK_USER_QUESTION_PROMPT },
      }),
    );
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
      transcript: { kind: 'none' },
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
          sessionId: fixture.sessionId,
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
    const started = requireStartedTurn(
      await client.startTurn({
        sessionId: fixture.sessionId,
        turnId,
        content: { text: FAKE_ASK_USER_QUESTION_PROMPT },
      }),
    );

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
    let stores: Awaited<ReturnType<typeof openInteractiveExecutionStoresForRead>> | undefined;
    try {
      stores = await openInteractiveExecutionStoresForRead(reader.lease);
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
        const userMessages: StoredMessage[] = (
          await stores.sessionStore.readMessages(recovered.sessionId)
        ).filter((message) => message.type === 'user' && message.turnId === recovered.turnId);
        assert.equal(userMessages.length, recovered.kind === 'linked_child_provider_retry' ? 0 : 1);
        if (recovered.kind !== 'linked_child_provider_retry') {
          assert.equal(userMessages[0]?.id, recovered.userMessageId);
        }
      }
    } finally {
      await stores?.sessionStore.close?.();
      await reader.close();
    }
  });
});
