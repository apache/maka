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
  quoteRefs,
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
      chain[1]?.sourceMessages.map(({ messageId, content, placement, disposition }) => ({
        messageId,
        content,
        placement,
        disposition,
      })),
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
    const started = requireStartedTurn(
      await first.startTurn({
        sessionId: fixture.sessionId,
        turnId,
        content: { text: FAKE_ASK_USER_QUESTION_PROMPT },
      }),
    );
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
    const started = requireStartedTurn(
      await first.startTurn({
        sessionId: fixture.sessionId,
        turnId,
        content: { text: FAKE_ASK_USER_QUESTION_PROMPT },
      }),
    );
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
