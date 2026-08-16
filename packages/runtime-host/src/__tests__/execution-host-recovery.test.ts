import assert from 'node:assert/strict';
import { fork, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { connect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

test('startup recovery rejects claimed graph Run lineage drift', async () => {
  await withExecutionRoot(async (fixture) => {
    await fixture.seedClaimedGraphRunLineageDrift();
    await fixture.expectHostStartupFailure();
    await fixture.assertOwnerAvailable();
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
    dropped.abort();

    const retried = requireStartedTurn(
      await observer.startTurn({
        sessionId: fixture.sessionId,
        turnId,
        content: { text },
      }),
    );
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
      requireStartedTurn(
        await successorClient.startTurn({
          sessionId: fixture.sessionId,
          turnId,
          content: { text },
        }),
      ),
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

test('startup recovery replays an admitted regenerate with its source lineage', async () => {
  await withExecutionRoot(async (fixture) => {
    const firstHost = await fixture.startHost();
    const first = await connectClient(fixture.root, 'desktop');
    const sourceTurnId = randomUUID();
    const regeneratedTurnId = randomUUID();
    await first.startTurn({
      sessionId: fixture.sessionId,
      turnId: sourceTurnId,
      content: quotedContent('recover this regeneration'),
    });
    await waitForTerminalTurn(first, fixture.sessionId, sourceTurnId);
    await first.close();
    await fixture.stopHost(firstHost);

    const admitted = await fixture.seedRegenerateAdmissionWithoutRun(
      sourceTurnId,
      regeneratedTurnId,
    );
    const successorHost = await fixture.startHost();
    const successor = await connectClient(fixture.root, 'tui');
    const terminal = await waitForTerminalTurn(successor, fixture.sessionId, regeneratedTurnId);
    assert.equal(terminal.runId, admitted.runId);
    await successor.close();
    await fixture.stopHost(successorHost);

    const ledger = await fixture.readTurn(regeneratedTurnId);
    assert.equal(ledger.runs.length, 1);
    assert.equal(ledger.userMessages.length, 1);
    assert.equal(ledger.runs[0]?.parentTurnId, sourceTurnId);
    assert.equal(ledger.runs[0]?.regeneratedFromTurnId, sourceTurnId);
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
    assert.deepEqual(
      chain[0]?.sourceMessages.map(({ messageId, content, placement, disposition }) => ({
        messageId,
        content,
        placement,
        disposition,
      })),
      [
        {
          messageId,
          content,
          placement: 'next_turn',
          disposition: 'turn_started',
        },
      ],
    );
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
