/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import { deferred } from '@maka/core/test-only/async-primitives';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { parseHTML } from 'linkedom';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { SessionEvent } from '@maka/core/events';
import type { ChatModelChoice } from '@maka/core/chat-model-choice';
import type { PermissionMode } from '@maka/core/permission';
import type {
  SessionChangedEvent,
  SessionSummary,
  TurnRecord,
} from '@maka/core/session';
import type { ContextCompactResult } from '@maka/runtime-host/protocol';
import {
  createFakeWorkbarServices,
  dispatchQuoteCompanionInput,
  useQuoteCompanion,
  sessionHasExactModelChoice,
  WorkbarServicesProvider,
  type CompanionQuoteSnapshot,
  type StagedCompanionQuote,
  type WorkbarServices,
} from '../../renderer/features/workbar/testing.js';

const originalGlobals = {
  document: globalThis.document,
  window: globalThis.window,
  HTMLElement: globalThis.HTMLElement,
  HTMLIFrameElement: globalThis.HTMLIFrameElement,
  Event: globalThis.Event,
  Node: globalThis.Node,
  IS_REACT_ACT_ENVIRONMENT: (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT,
};

let mountedRoot: Root | undefined;
const SOURCE_SESSION = session('source-session');
type SideChatStopTarget = Parameters<WorkbarServices['sideChat']['stop']>[1];
type QueueUpdate = Extract<SessionEvent, { type: 'queue_update' }>;
type QueueEntry = NonNullable<QueueUpdate['steeringEntries']>[number];

function completeEvent(id: string, turnId: string, ts: number): SessionEvent {
  return { type: 'complete', id, turnId, ts, stopReason: 'end_turn' };
}

function textDeltaEvent(id: string, turnId: string, ts: number, text: string): SessionEvent {
  return { type: 'text_delta', id, messageId: 'assistant-message', turnId, ts, text };
}

function queueUpdateEvent(
  id: string,
  turnId: string,
  ts: number,
  steeringEntries: readonly QueueEntry[] = [],
  followupEntries: readonly QueueEntry[] = [],
): QueueUpdate {
  return {
    type: 'queue_update',
    id,
    turnId,
    ts,
    queueRevision: 1,
    steering: steeringEntries.map((entry) => entry.content.text),
    followup: followupEntries.map((entry) => entry.content.text),
    steeringEntries: [...steeringEntries],
    followupEntries: [...followupEntries],
  };
}

function messageAdmittedEvent(
  id: string,
  turnId: string,
  ts: number,
  messageId: string,
): SessionEvent {
  return { type: 'message_admission', id, messageId, turnId, ts, outcome: 'admitted' };
}

function recoverableErrorEvent(id: string, turnId: string, ts: number): SessionEvent {
  return {
    type: 'error',
    id,
    turnId,
    ts,
    recoverable: true,
    reason: 'connection_closed',
    message: 'connection closed',
  };
}

function installDom() {
  const parsed = parseHTML('<html><body><div id="root"></div></body></html>');
  const { document, window } = parsed;
  Object.assign(globalThis, {
    document,
    window,
    HTMLElement: window.HTMLElement,
    HTMLIFrameElement: window.HTMLIFrameElement ?? class HTMLIFrameElement {},
    Event: window.Event,
    Node: window.Node,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const container = document.querySelector('#root');
  assert.ok(container);
  return container;
}

async function renderProbe(
  sideChat: Partial<WorkbarServices['sideChat']>,
  options: {
    ownership?: boolean;
    sourceSession?: SessionSummary;
    modelChoices?: readonly ChatModelChoice[];
    ready?: (container: Element) => boolean;
    onSend?: (send: (text: string) => Promise<boolean>) => void;
    onSteer?: (steer: (text: string) => Promise<boolean>) => void;
    onStop?: (stop: () => Promise<void>) => void;
    onSetPermissionMode?: (set: (mode: PermissionMode) => Promise<boolean>) => void;
    confirmBypass?: () => Promise<boolean>;
    onContextCompactionError?: (sessionId: string, error: unknown) => void;
    pendingQuotes?: readonly StagedCompanionQuote[];
    onQuotesConsumed?: (snapshot: CompanionQuoteSnapshot) => void;
  } = {},
) {
  const container = installDom();
  const defaults = createFakeWorkbarServices();
  const services: WorkbarServices = {
    ...defaults,
    sideChat: {
      ...defaults.sideChat,
      listTurns: async () => [settledTurn('source-turn')],
      branchFromTurn: async () => ({ ok: true as const, session: session('side-conversation') }),
      ...sideChat,
    },
  };
  const root = createRoot(container);
  mountedRoot = root;
  const children = options.ownership
    ? createElement(QuoteCompanionOwnershipProbe, {
        onSend: options.onSend ?? (() => undefined),
        onSteer: options.onSteer,
        onStop: options.onStop,
        onSetPermissionMode: options.onSetPermissionMode,
        onContextCompactionError: options.onContextCompactionError,
        pendingQuotes: options.pendingQuotes,
        onQuotesConsumed: options.onQuotesConsumed,
        sourceSession: options.sourceSession,
        modelChoices: options.modelChoices,
      })
    : createElement(QuoteCompanionProbe, {
        sourceSession: options.sourceSession,
        modelChoices: options.modelChoices,
        onSetPermissionMode: options.onSetPermissionMode,
        confirmBypass: options.confirmBypass,
      });

  await act(async () => {
    root.render(createElement(WorkbarServicesProvider, { services, children }));
    await Promise.resolve();
  });
  await waitUntil(
    () =>
      // The fork is created lazily on the first send, so mounting no longer
      // produces a companion. Default readiness is just "the probe mounted".
      options.ready?.(container) ?? container.firstElementChild != null,
  );
  return { container, root, services };
}

async function renderOwnershipProbe(
  sideChat: Partial<WorkbarServices['sideChat']>,
  options: {
    pendingQuotes?: readonly StagedCompanionQuote[];
    onQuotesConsumed?: (snapshot: CompanionQuoteSnapshot) => void;
    sourceSession?: SessionSummary;
    modelChoices?: readonly ChatModelChoice[];
    onContextCompactionError?: (sessionId: string, error: unknown) => void;
  } = {},
) {
  let send!: (text: string) => Promise<boolean>;
  let steer!: (text: string) => Promise<boolean>;
  let stop!: () => Promise<void>;
  let setPermissionMode!: (mode: PermissionMode) => Promise<boolean>;
  let eventHandler: ((event: SessionEvent) => void) | undefined;
  const subscribeEvents = sideChat.subscribeEvents;
  const rendered = await renderProbe(
    {
      ...sideChat,
      subscribeEvents: (sessionId, handler, onSeeded, onSeedError) => {
        eventHandler = handler;
        if (subscribeEvents) {
          return subscribeEvents(sessionId, handler, onSeeded, onSeedError);
        }
        onSeeded?.();
        return () => undefined;
      },
    },
    {
      ownership: true,
      onSend: (value) => (send = value),
      onSteer: (value) => (steer = value),
      onStop: (value) => (stop = value),
      onSetPermissionMode: (value) => (setPermissionMode = value),
      ...options,
    },
  );
  return {
    ...rendered,
    send: (text: string) => send(text),
    steer: (text: string) => steer(text),
    stop: () => stop(),
    setPermissionMode: (mode: PermissionMode) => setPermissionMode(mode),
    emit(event: SessionEvent) {
      assert.ok(eventHandler);
      eventHandler(event);
    },
  };
}

async function commitIdleCompanion(
  rendered: Awaited<ReturnType<typeof renderOwnershipProbe>>,
): Promise<void> {
  await act(async () => {
    assert.equal(await rendered.send('prepare side conversation'), false);
    await Promise.resolve();
  });
  await awaitCompanion(rendered.container);
}

const REBOUND_MODEL: Partial<SessionSummary> = {
  llmConnectionId: 'connection-2',
  llmConnectionSlug: 'openai-2',
  model: 'model-2',
};

function exactModelRebindScenario() {
  const sourceA = session('source-session');
  const sourceB = session('source-session', REBOUND_MODEL);
  return {
    sourceA,
    sourceB,
    forkB: session('side-conversation-b', REBOUND_MODEL),
  };
}

function probeTree(
  services: WorkbarServices,
  sourceSession: SessionSummary,
  modelChoices: readonly ChatModelChoice[] = [choiceFor(sourceSession)],
) {
  return createElement(WorkbarServicesProvider, {
    services,
    children: createElement(QuoteCompanionProbe, { sourceSession, modelChoices }),
  });
}

async function rerenderProbeSource(
  rendered: { root: Root; services: WorkbarServices },
  sourceSession: SessionSummary,
  modelChoices: readonly ChatModelChoice[] = [choiceFor(sourceSession)],
) {
  await act(async () => {
    rendered.root.render(probeTree(rendered.services, sourceSession, modelChoices));
    await Promise.resolve();
  });
}

function ownershipProbeTree(
  services: WorkbarServices,
  sourceSession: SessionSummary,
  onSend: (send: (text: string) => Promise<boolean>) => void,
) {
  return createElement(WorkbarServicesProvider, {
    services,
    children: createElement(QuoteCompanionOwnershipProbe, {
      onSend,
      sourceSession,
      modelChoices: [choiceFor(sourceSession)],
    }),
  });
}

async function rerenderOwnershipSource(
  rendered: { root: Root; services: WorkbarServices },
  sourceSession: SessionSummary,
  onSend: (send: (text: string) => Promise<boolean>) => void,
) {
  await act(async () => {
    rendered.root.render(ownershipProbeTree(rendered.services, sourceSession, onSend));
    await Promise.resolve();
  });
}

afterEach(async () => {
  if (mountedRoot) {
    await act(async () => {
      mountedRoot?.unmount();
      await Promise.resolve();
    });
  }
  mountedRoot = undefined;
  Object.assign(globalThis, originalGlobals);
});

test('first send while the source is still on its first turn forks with an empty context', async () => {
  const branchInputs: (string | undefined)[] = [];
  const rendered = await renderOwnershipProbe({
    // The panel opens while the main session is still running its first turn:
    // no completed turn exists to branch from yet.
    listTurns: async () => [runningTurn('first-turn')],
    branchFromTurn: async (_sessionId, input) => {
      branchInputs.push(input.sourceTurnId);
      return { ok: true as const, session: session('side-conversation') };
    },
    send: async () => ({ ok: true as const, turnId: 'empty-first-turn' }),
  });
  const probe = rendered.container.firstElementChild;
  assert.ok(probe);
  // No eager fork at mount — the composer is immediately usable and nothing is
  // branched until the user sends.
  assert.equal(branchInputs.length, 0);
  assert.equal(probe.getAttribute('data-companion-id'), '');

  await act(async () => {
    assert.equal(await rendered.send('explain the running turn'), true);
    await Promise.resolve();
  });
  await awaitCompanion(rendered.container);
  // Forking mid-first-turn copies no source transcript: an empty context.
  assert.deepEqual(branchInputs, [undefined]);
  assert.equal(probe.getAttribute('data-error'), '');
});

test('first send after a completed turn forks through the settled turn', async () => {
  const branchInputs: (string | undefined)[] = [];
  const rendered = await renderOwnershipProbe({
    listTurns: async () => [settledTurn('done-turn')],
    branchFromTurn: async (_sessionId, input) => {
      branchInputs.push(input.sourceTurnId);
      return { ok: true as const, session: session('side-conversation') };
    },
    send: async () => ({ ok: true as const, turnId: 'through-turn' }),
  });
  const probe = rendered.container.firstElementChild;
  assert.ok(probe);
  assert.equal(branchInputs.length, 0);

  await act(async () => {
    assert.equal(await rendered.send('explain the finished turn'), true);
    await Promise.resolve();
  });
  await awaitCompanion(rendered.container);
  // A settled turn exists, so the fork carries the full context through it.
  assert.deepEqual(branchInputs, ['done-turn']);
  assert.equal(probe.getAttribute('data-error'), '');
});

test('a first send shows the question bubble immediately but arms Stop only once the fork exists', async () => {
  // `branchFromTurn` is the Host round trip a first send waits on. Holding it
  // open lets us observe the panel while the fork is still being created.
  const branch = deferred<{ ok: true; session: SessionSummary }>();
  const rendered = await renderOwnershipProbe({
    listTurns: async () => [settledTurn('done-turn')],
    branchFromTurn: () => branch.promise,
    send: async () => ({ ok: true as const, turnId: 'first-turn' }),
  });
  const probe = rendered.container.firstElementChild;
  assert.ok(probe);
  // Nothing sent yet: no fork, no bubble, not streaming.
  assert.equal(probe.getAttribute('data-companion-id'), '');
  assert.equal(probe.getAttribute('data-transient-count'), '0');
  assert.equal(probe.getAttribute('data-streaming'), 'false');

  // Kick off the send but leave fork creation pending (branch unresolved).
  let sendResult!: Promise<boolean>;
  await act(async () => {
    sendResult = rendered.send('why does this fail?');
    await Promise.resolve();
  });
  await waitUntil(() => probe.getAttribute('data-transient-count') === '1');

  // The fork has NOT committed yet, but the question bubble is already on screen
  // — the instant feedback #4654 asked for, and what the panel's running-status
  // line rides on (`streaming || transientMessages.length > 0`) before a turn
  // exists. Crucially `streaming` is still false, so the Composer does NOT render
  // a Stop button during the window where `stop()` is a no-op (companionIdRef is
  // only set at commitFork). Arming the admission early would show a dead Stop.
  assert.equal(probe.getAttribute('data-companion-id'), '');
  assert.equal(probe.getAttribute('data-transient-text'), 'why does this fail?');
  assert.equal(probe.getAttribute('data-streaming'), 'false');

  // Once the fork commits and the send goes in flight, the admission arms:
  // streaming turns true, so Stop appears exactly when it can act on the turn.
  await act(async () => {
    branch.resolve({ ok: true as const, session: session('side-conversation') });
    assert.equal(await sendResult, true);
    await Promise.resolve();
  });
  await awaitCompanion(rendered.container);
  await waitUntil(() => probe.getAttribute('data-streaming') === 'true');
  assert.equal(probe.getAttribute('data-error'), '');
  assert.equal(probe.getAttribute('data-transient-count'), '1');

  // The running state rides the whole turn and only retires on completion.
  await act(async () => {
    rendered.emit(completeEvent('c1', 'first-turn', 2));
    await Promise.resolve();
  });
  await waitUntil(() => probe.getAttribute('data-streaming') === 'false');
});

test('a failed first send retires the optimistic bubble without ever arming Stop', async () => {
  // The fork never materializes: `branchFromTurn` throws. The optimistic bubble
  // must be unwound so nothing is stranded with no turn to reconcile it away, and
  // Stop must never have appeared (the admission is armed only in onBeforeSend).
  const rendered = await renderOwnershipProbe({
    listTurns: async () => [settledTurn('done-turn')],
    branchFromTurn: async () => {
      throw new Error('fork setup exploded');
    },
  });
  const probe = rendered.container.firstElementChild;
  assert.ok(probe);

  await act(async () => {
    assert.equal(await rendered.send('why does this fail?'), false);
    await Promise.resolve();
  });
  assert.equal(probe.getAttribute('data-companion-id'), '');
  assert.equal(probe.getAttribute('data-transient-count'), '0');
  assert.equal(probe.getAttribute('data-streaming'), 'false');
  assert.equal(probe.getAttribute('data-live-turn-id'), '');
});

test('dispatches /compact to the committed companion fork without sending model input', async () => {
  const compactCalls: string[] = [];
  let sendCalls = 0;
  let steerCalls = 0;
  const rendered = await renderOwnershipProbe({
    compact: async (sessionId) => {
      compactCalls.push(sessionId);
      return {
        kind: 'finished' as const,
        turn: {
          sessionId,
          turnId: 'compact-turn',
          runId: 'compact-run',
          status: 'completed' as const,
          terminalEventId: 'compact-complete',
          contextCompactionOutcome: { kind: 'unchanged' as const, reason: 'already_current' },
        },
        outcome: { kind: 'unchanged' as const, reason: 'already_current' },
      };
    },
    send: async () => {
      sendCalls += 1;
      return { ok: false as const, reason: 'seed only' };
    },
    steer: async () => {
      steerCalls += 1;
      return { kind: 'started' as const, turnId: 'unexpected-steer' };
    },
  });

  await commitIdleCompanion(rendered);
  sendCalls = 0;
  assert.equal(await rendered.send('  /compact  '), true);
  assert.deepEqual(compactCalls, ['side-conversation']);
  assert.equal(sendCalls, 0);
  assert.equal(steerCalls, 0);
});

test('dispatches the exact /compact Composer command before steering or ordinary send', async () => {
  const calls: string[] = [];
  assert.equal(
    await dispatchQuoteCompanionInput({
      text: '  /compact  ',
      streaming: true,
      compact: async () => {
        calls.push('compact');
        return true;
      },
      steer: async () => {
        calls.push('steer');
        return true;
      },
      send: async () => {
        calls.push('send');
        return true;
      },
    }),
    true,
  );
  assert.deepEqual(calls, ['compact']);
});

test('keeps an async companion compaction exclusive until its terminal event', async () => {
  let compactCalls = 0;
  let sendCalls = 0;
  const rendered = await renderOwnershipProbe({
    compact: async (sessionId) => {
      compactCalls += 1;
      return {
        kind: 'started' as const,
        turn: {
          sessionId,
          turnId: 'compact-turn',
          runId: 'compact-run',
          status: 'running' as const,
        },
      };
    },
    send: async () => {
      sendCalls += 1;
      return { ok: false as const, reason: 'seed only' };
    },
  });

  await commitIdleCompanion(rendered);
  sendCalls = 0;
  assert.equal(await rendered.send('/compact'), true);
  assert.equal(await rendered.send('ordinary question'), false);
  assert.equal(compactCalls, 1);
  assert.equal(sendCalls, 0);
});

test('releases an async companion compaction after a Host interruption', async () => {
  let compactCalls = 0;
  const compactionErrors: Array<{ sessionId: string; error: unknown }> = [];
  const rendered = await renderOwnershipProbe(
    {
      compact: async (sessionId) => {
        compactCalls += 1;
        return {
          kind: 'started' as const,
          turn: {
            sessionId,
            turnId: `compact-turn-${compactCalls}`,
            runId: `compact-run-${compactCalls}`,
            status: 'running' as const,
          },
        };
      },
    },
    {
      onContextCompactionError: (sessionId, error) => {
        compactionErrors.push({ sessionId, error });
      },
    },
  );

  await commitIdleCompanion(rendered);
  assert.equal(await rendered.send('/compact'), true);
  assert.equal(await rendered.send('/compact'), false);
  await act(async () => {
    rendered.emit({
      type: 'abort',
      id: 'compact-aborted',
      turnId: 'compact-turn-1',
      ts: 1,
      reason: 'crash',
    });
    await Promise.resolve();
  });

  assert.equal(await rendered.send('/compact'), true);
  assert.equal(compactCalls, 2);
  assert.equal(compactionErrors.length, 1);
  assert.equal(compactionErrors[0]?.sessionId, 'side-conversation');
  assert.equal((compactionErrors[0]?.error as SessionEvent | undefined)?.type, 'abort');
});

test('does not settle a pending companion compaction from another turn outcome', async () => {
  const pendingCompact = deferred<ContextCompactResult>();
  let compactCalls = 0;
  const rendered = await renderOwnershipProbe({
    compact: async (sessionId) => {
      compactCalls += 1;
      if (compactCalls === 1) return pendingCompact.promise;
      return {
        kind: 'finished' as const,
        turn: {
          sessionId,
          turnId: 'compact-turn-after-guard',
          runId: 'compact-run-after-guard',
          status: 'completed' as const,
          terminalEventId: 'compact-complete-after-guard',
          contextCompactionOutcome: { kind: 'unchanged' as const, reason: 'already_current' },
        },
        outcome: { kind: 'unchanged' as const, reason: 'already_current' },
      };
    },
  });

  await commitIdleCompanion(rendered);
  let compactResult!: Promise<boolean>;
  await act(async () => {
    compactResult = rendered.send('/compact');
    await Promise.resolve();
  });
  await act(async () => {
    rendered.emit({
      type: 'complete',
      id: 'unrelated-complete',
      turnId: 'unrelated-turn',
      ts: 1,
      stopReason: 'end_turn',
      contextCompactionOutcome: { kind: 'unchanged', reason: 'already_current' },
    });
    await Promise.resolve();
  });

  assert.equal(await rendered.send('/compact'), false);
  pendingCompact.resolve({
    kind: 'started',
    turn: {
      sessionId: 'side-conversation',
      turnId: 'compact-turn-unrelated-guard',
      runId: 'compact-run-unrelated-guard',
      status: 'running',
    },
  });
  assert.equal(await compactResult, true);
  assert.equal(compactCalls, 1);

  await act(async () => {
    rendered.emit({
      type: 'complete',
      id: 'compact-complete',
      turnId: 'compact-turn-unrelated-guard',
      ts: 2,
      stopReason: 'end_turn',
      contextCompactionOutcome: { kind: 'unchanged', reason: 'already_current' },
    });
    await Promise.resolve();
  });
  assert.equal(await rendered.send('/compact'), true);
  assert.equal(compactCalls, 2);
});

test('clears a failed companion compaction request so it can be retried', async () => {
  let compactCalls = 0;
  const rendered = await renderOwnershipProbe({
    compact: async (sessionId) => {
      compactCalls += 1;
      if (compactCalls === 1) throw new Error('temporary compact failure');
      return {
        kind: 'finished' as const,
        turn: {
          sessionId,
          turnId: 'compact-retry-turn',
          runId: 'compact-retry-run',
          status: 'completed' as const,
          terminalEventId: 'compact-retry-complete',
          contextCompactionOutcome: { kind: 'unchanged' as const, reason: 'already_current' },
        },
        outcome: { kind: 'unchanged' as const, reason: 'already_current' },
      };
    },
  });

  await commitIdleCompanion(rendered);
  assert.equal(await rendered.send('/compact'), false);
  assert.equal(await rendered.send('/compact'), true);
  assert.equal(compactCalls, 2);
});

test('rejects /compact while the companion is running without consuming staged quotes', async () => {
  const pendingSend = deferred<{ ok: true; turnId: string }>();
  let compactCalls = 0;
  const consumed: CompanionQuoteSnapshot[] = [];
  const rendered = await renderOwnershipProbe(
    {
      compact: async () => {
        compactCalls += 1;
        throw new Error('compact should not run while busy');
      },
      send: () => pendingSend.promise,
    },
    {
      pendingQuotes: [{ id: 'quote-1', value: { text: 'quoted context' } }],
      onQuotesConsumed: (snapshot) => consumed.push(snapshot),
    },
  );

  let sendResult!: Promise<boolean>;
  await act(async () => {
    sendResult = rendered.send('ordinary question');
    await Promise.resolve();
  });
  assert.equal(await rendered.send('/compact'), false);
  assert.equal(compactCalls, 0);
  assert.deepEqual(consumed, []);

  await act(async () => {
    pendingSend.resolve({ ok: true, turnId: 'running-turn' });
    assert.equal(await sendResult, true);
  });
});

test('rejects /compact while the companion fork is preparing', async () => {
  const pendingFork = deferred<SessionSummary>();
  let compactCalls = 0;
  let branchStarted = false;
  const rendered = await renderOwnershipProbe({
    branchFromTurn: async () => {
      branchStarted = true;
      return { ok: true as const, session: await pendingFork.promise };
    },
    compact: async () => {
      compactCalls += 1;
      throw new Error('compact should not run before fork commit');
    },
  });

  let sendResult!: Promise<boolean>;
  await act(async () => {
    sendResult = rendered.send('prepare pending fork');
    await Promise.resolve();
  });
  await waitUntil(() => branchStarted);
  assert.equal(await rendered.send('/compact'), false);
  assert.equal(compactCalls, 0);
  await act(async () => {
    pendingFork.resolve(session('side-conversation'));
    assert.equal(await sendResult, false);
  });
});

test('rejects /compact for an archived companion fork without invoking Runtime Host', async () => {
  let compactCalls = 0;
  const rendered = await renderOwnershipProbe({
    branchFromTurn: async () => ({
      ok: true as const,
      session: session('side-conversation', { isArchived: true }),
    }),
    compact: async () => {
      compactCalls += 1;
      throw new Error('compact should not run for an archived fork');
    },
  });

  await commitIdleCompanion(rendered);
  assert.equal(await rendered.send('/compact'), false);
  assert.equal(compactCalls, 0);
});

test('does not fork on mount or when the source Session object refreshes', async () => {
  let branchCount = 0;
  const { container, root, services } = await renderProbe(
    {
      listTurns: async () => [settledTurn('settled-turn')],
      branchFromTurn: async () => {
        branchCount += 1;
        return { ok: true as const, session: session('side-conversation') };
      },
    },
    { sourceSession: session('source-session') },
  );
  const probe = container.firstElementChild;
  assert.ok(probe);
  // Lazy fork: mounting never branches, and the composer is immediately usable.
  assert.equal(branchCount, 0);
  assert.equal(probe.getAttribute('data-companion-id'), '');

  await act(async () => {
    root.render(
      createElement(WorkbarServicesProvider, {
        services,
        children: createElement(QuoteCompanionProbe, {
          sourceSession: session('source-session'),
        }),
      }),
    );
    await Promise.resolve();
  });
  // A refreshed source identity must not spuriously trigger a fork.
  assert.equal(branchCount, 0);
});

test('does not fork or send when the source model is unavailable', async () => {
  let branchCount = 0;
  const rendered = await renderOwnershipProbe(
    {
      listTurns: async () => [settledTurn('settled-turn')],
      branchFromTurn: async () => {
        branchCount += 1;
        return { ok: true as const, session: session('side-conversation') };
      },
    },
    { sourceSession: session('source-session'), modelChoices: [] },
  );
  const probe = rendered.container.firstElementChild;
  assert.ok(probe);
  assert.equal(branchCount, 0);

  await act(async () => {
    assert.equal(await rendered.send('cannot send without a ready model'), false);
    await Promise.resolve();
  });
  // The send is refused before any branch is attempted.
  assert.equal(branchCount, 0);
  assert.equal(probe.getAttribute('data-companion-id'), '');
});

test('cleans up a first-send fork whose model no longer matches on commit', async () => {
  const source = session('source-session');
  const mismatchedFork = session('side-conversation', REBOUND_MODEL);
  const cleaned: string[] = [];
  let branchCount = 0;
  const rendered = await renderOwnershipProbe(
    {
      listTurns: async () => [settledTurn('settled-turn')],
      branchFromTurn: async () => {
        branchCount += 1;
        return { ok: true as const, session: mismatchedFork };
      },
      cleanupSessionCopy: async (sessionId) => {
        cleaned.push(sessionId);
      },
    },
    { sourceSession: source, modelChoices: [choiceFor(source)] },
  );
  const probe = rendered.container.firstElementChild;
  assert.ok(probe);

  await act(async () => {
    assert.equal(await rendered.send('the fork model drifted'), false);
    await Promise.resolve();
  });
  await waitUntil(() => cleaned.length === 1);
  // The fork committed but its model is no longer authorized, so it is torn
  // down instead of being adopted.
  assert.equal(branchCount, 1);
  assert.deepEqual(cleaned, ['side-conversation']);
  assert.equal(probe.getAttribute('data-companion-id'), '');
});

test('retains a fork whose in-flight send is waiting for observation when the model rebinds', async () => {
  const { sourceA, sourceB } = exactModelRebindScenario();
  let branchCount = 0;
  let seedA: (() => void) | undefined;
  const cleaned: string[] = [];
  const sendTargets: string[] = [];
  let currentSend!: (text: string) => Promise<boolean>;
  const rendered = await renderOwnershipProbe(
    {
      branchFromTurn: async () => {
        branchCount += 1;
        return { ok: true as const, session: session('side-conversation') };
      },
      subscribeEvents: (sessionId, _handler, onSeeded) => {
        if (sessionId === 'side-conversation') seedA = onSeeded;
        else onSeeded?.();
        return () => undefined;
      },
      cleanupSessionCopy: async (sessionId) => {
        cleaned.push(sessionId);
      },
      send: async (sessionId) => {
        sendTargets.push(sessionId);
        return { ok: false as const, reason: 'not configured' };
      },
    },
    {
      sourceSession: sourceA,
      modelChoices: [choiceFor(sourceA)],
    },
  );
  currentSend = rendered.send;

  let firstSend!: Promise<boolean>;
  await act(async () => {
    firstSend = currentSend('waiting send');
    await Promise.resolve();
  });
  // Let the lazy fork commit and establish its subscription (which then blocks
  // the send on observation readiness) before the source model rebinds.
  await waitUntil(() => seedA !== undefined);
  await act(async () => {
    rendered.root.render(ownershipProbeTree(rendered.services, sourceB, (send) => {
      currentSend = send;
    }));
    await Promise.resolve();
  });
  // An in-flight send holds the submit lock, so the model rebind must not
  // implicitly discard or replace the fork it is still waiting on.
  assert.deepEqual(cleaned, [], 'the send lock must retain its fork');

  await act(async () => {
    seedA?.();
    assert.equal(await firstSend, false);
  });
  const probe = rendered.container.firstElementChild;
  assert.ok(probe);
  // The one fork was reused for the send and never cleaned up behind it.
  assert.deepEqual(sendTargets, ['side-conversation']);
  assert.deepEqual(cleaned, []);
  assert.equal(branchCount, 1);
  assert.equal(probe.getAttribute('data-companion-id'), 'side-conversation');
});

test('retains an admitted fork interrupted before send settles when its model changes', async () => {
  const { sourceA, sourceB } = exactModelRebindScenario();
  const pendingSend = deferred<{ ok: true; turnId: string }>();
  const pendingStop = deferred<undefined>();
  const cleaned: string[] = [];
  let admissionId: string | undefined;
  let branchCount = 0;
  let currentSend!: (text: string) => Promise<boolean>;
  const rendered = await renderOwnershipProbe(
    {
      branchFromTurn: async () => {
        branchCount += 1;
        return { ok: true as const, session: session('side-conversation') };
      },
      cleanupSessionCopy: async (sessionId) => {
        cleaned.push(sessionId);
      },
      send: async (_sessionId, command) => {
        admissionId = command.turnId;
        return pendingSend.promise;
      },
      stop: async (_sessionId, target) => {
        assert.deepEqual(target, { kind: 'admission', messageId: admissionId });
        return pendingStop.promise;
      },
    },
    {
      sourceSession: sourceA,
      modelChoices: [choiceFor(sourceA)],
    },
  );
  currentSend = rendered.send;

  let sendResult!: Promise<boolean>;
  await act(async () => {
    sendResult = currentSend('persisted before interruption');
    await Promise.resolve();
  });
  await waitUntil(() => admissionId !== undefined);
  let stopResult!: Promise<void>;
  await act(async () => {
    stopResult = rendered.stop();
    await Promise.resolve();
    pendingSend.resolve({ ok: true, turnId: 'admitted-turn' });
    await Promise.resolve();
  });
  const probe = rendered.container.firstElementChild;
  assert.ok(probe);
  await waitUntil(() => probe.getAttribute('data-live-turn-id') === 'admitted-turn');

  await act(async () => {
    pendingStop.resolve(undefined);
    await stopResult;
    assert.equal(await sendResult, false);
  });
  await act(async () => {
    rendered.emit(completeEvent('interrupted-complete', 'admitted-turn', 1));
    await Promise.resolve();
  });
  await waitUntil(() => probe.getAttribute('data-live-turn-id') === '');

  await rerenderOwnershipSource(rendered, sourceB, (send) => { currentSend = send; });
  assert.equal(probe.getAttribute('data-companion-id'), 'side-conversation');
  assert.deepEqual(cleaned, [], 'Host-admitted content must never be replaced implicitly');
  assert.equal(branchCount, 1);
});

test('source model readiness requires the exact Connection id, slug, and model', () => {
  const source = session('source-session');
  assert.equal(sessionHasExactModelChoice(source, [choiceFor(source)]), true);
  const legacy = { ...source };
  delete legacy.llmConnectionId;
  assert.equal(sessionHasExactModelChoice(legacy, [choiceFor(source)]), false);
  assert.equal(sessionHasExactModelChoice(source, []), false);
  assert.equal(
    sessionHasExactModelChoice(source, [choiceFor(source, { connectionId: 'other' })]),
    false,
  );
  assert.equal(
    sessionHasExactModelChoice(source, [choiceFor(source, { connectionSlug: 'other' })]),
    false,
  );
  assert.equal(
    sessionHasExactModelChoice(source, [choiceFor(source, { model: 'other' })]),
    false,
  );
});

test('keeps Side Conversation events owned by the Host-admitted turn across an admission race', async () => {
  const pendingSend = deferred<{ ok: true; turnId: string }>();
  const { container, emit, send } = await renderOwnershipProbe({
    send: async () => pendingSend.promise,
  });

  let sendResult!: Promise<boolean>;
  await act(async () => {
    sendResult = send('new prompt');
    await Promise.resolve();
  });
  await awaitProcessing(container);

  await act(async () => {
    emit(completeEvent('late-old-terminal', 'old-turn', 1));
    await Promise.resolve();
  });
  assert.equal(container.firstElementChild?.getAttribute('data-processing'), 'true');

  await act(async () => {
    emit(textDeltaEvent('new-text-before-response', 'host-admitted-turn', 2, 'answer'));
    await Promise.resolve();
  });
  assert.equal(container.firstElementChild?.getAttribute('data-processing'), 'true');

  await act(async () => {
    pendingSend.resolve({ ok: true, turnId: 'host-admitted-turn' });
    assert.equal(await sendResult, true);
    await Promise.resolve();
  });

  const probe = container.firstElementChild;
  assert.ok(probe);
  assert.equal(probe.getAttribute('data-live-turn-id'), 'host-admitted-turn');
  assert.equal(probe.getAttribute('data-live-text'), 'answer');
  assert.equal(probe.getAttribute('data-streaming'), 'true');
  assert.equal(probe.getAttribute('data-processing'), 'false');
});

test('binds a busy-raced Side Conversation send through its Host-admitted message identity', async () => {
  let admissionId: string | undefined;
  let consumed = 0;
  const pendingSend = deferred<{
    ok: true;
    steered: true;
    turnId: string;
    messageId: string;
  }>();
  const { container, emit, send } = await renderOwnershipProbe(
    {
      send: async (_sessionId, command) => {
        admissionId = command.turnId;
        return pendingSend.promise;
      },
    },
    {
      pendingQuotes: [{ id: 'quote-1', value: { text: 'quoted context' } }],
      onQuotesConsumed: () => {
        consumed += 1;
      },
    },
  );

  let sendResult!: Promise<boolean>;
  await act(async () => {
    sendResult = send('steer the active turn');
    await Promise.resolve();
  });
  await waitUntil(() => admissionId !== undefined);
  await act(async () => {
    emit(completeEvent('late-old-terminal', 'old-turn', 1));
    emit(
      queueUpdateEvent('accepted-queue', 'host-active-turn', 2, [
        {
          entryId: 'accepted-entry',
          messageId: admissionId as string,
          content: { text: 'steer the active turn' },
          placement: 'current_turn',
          state: 'queued',
        },
      ]),
    );
    await Promise.resolve();
  });
  assert.equal(container.firstElementChild?.getAttribute('data-processing'), 'true');
  assert.notEqual(
    container.firstElementChild?.getAttribute('data-live-turn-id'),
    'host-active-turn',
  );
  assert.equal(consumed, 0);

  await act(async () => {
    pendingSend.resolve({
      ok: true,
      steered: true,
      turnId: 'requested-turn-is-not-the-owner',
      messageId: admissionId as string,
    });
    assert.equal(await sendResult, true);
    await Promise.resolve();
  });
  assert.notEqual(
    container.firstElementChild?.getAttribute('data-live-turn-id'),
    'host-active-turn',
  );
  await act(async () => {
    emit(
      messageAdmittedEvent(
        'accepted-admission',
        'host-active-turn',
        2.5,
        admissionId as string,
      ),
    );
    emit(textDeltaEvent('accepted-text', 'host-active-turn', 3, 'answer after steering'));
    await Promise.resolve();
  });

  const probe = container.firstElementChild;
  assert.ok(probe);
  assert.equal(probe.getAttribute('data-live-turn-id'), 'host-active-turn');
  assert.equal(probe.getAttribute('data-live-text'), 'answer after steering');
  assert.equal(probe.getAttribute('data-streaming'), 'true');
  assert.equal(probe.getAttribute('data-processing'), 'false');
  assert.equal(consumed, 1);
});

test('keeps staged quotes when Host retracts a busy-raced Side Conversation send', async () => {
  let admissionId: string | undefined;
  let consumed = 0;
  const pendingSend = deferred<{
    ok: true;
    steered: true;
    turnId: string;
    messageId: string;
  }>();
  const { emit, send } = await renderOwnershipProbe(
    {
      send: async (_sessionId, command) => {
        admissionId = command.turnId;
        return pendingSend.promise;
      },
    },
    {
      pendingQuotes: [{ id: 'quote-1', value: { text: 'quoted context' } }],
      onQuotesConsumed: () => {
        consumed += 1;
      },
    },
  );

  let sendResult!: Promise<boolean>;
  await act(async () => {
    sendResult = send('do not consume this quote');
    await Promise.resolve();
  });
  await waitUntil(() => admissionId !== undefined);
  await act(async () => {
    emit({
      type: 'message_admission',
      id: 'busy-raced-send-retracted',
      turnId: 'old-turn',
      ts: 1,
      messageId: admissionId as string,
      outcome: 'retracted',
    });
    pendingSend.resolve({
      ok: true,
      steered: true,
      turnId: 'old-turn',
      messageId: admissionId as string,
    });
    assert.equal(await sendResult, false);
    await Promise.resolve();
  });

  assert.equal(consumed, 0);
});

test('replays queued Side Conversation text after Host assigns the ticket to a successor Turn', async () => {
  let admissionId: string | undefined;
  const pendingSend = deferred<{
    ok: false;
    reason: 'outcome_unknown';
    messageId: string;
  }>();
  const { container, emit, send } = await renderOwnershipProbe({
    send: async (_sessionId, command) => {
      admissionId = command.turnId;
      return pendingSend.promise;
    },
  });

  let sendResult!: Promise<boolean>;
  await act(async () => {
    sendResult = send('continue in the successor turn');
    await Promise.resolve();
  });
  await waitUntil(() => admissionId !== undefined);
  await act(async () => {
    emit(
      messageAdmittedEvent(
        'successor-admission',
        'successor-root',
        1,
        admissionId as string,
      ),
    );
    emit(queueUpdateEvent('successor-queue', 'successor-root', 2));
    emit(textDeltaEvent('successor-text', 'successor-root', 3, 'answer from successor'));
    await Promise.resolve();
  });

  await act(async () => {
    pendingSend.resolve({
      ok: false,
      reason: 'outcome_unknown',
      messageId: admissionId as string,
    });
    assert.equal(await sendResult, true);
    await Promise.resolve();
  });

  const probe = container.firstElementChild;
  assert.ok(probe);
  assert.equal(probe.getAttribute('data-live-turn-id'), 'successor-root');
  assert.equal(probe.getAttribute('data-live-text'), 'answer from successor');
  assert.equal(probe.getAttribute('data-processing'), 'false');
});

test('binds an unproven Side Conversation send through the durable transcript', async () => {
  let admissionId: string | undefined;
  const pendingSend = deferred<{
    ok: false;
    reason: 'outcome_unknown';
    messageId: string;
  }>();
  // The Host opened a root Turn under its own identity and the answer was lost.
  // No `message_admission` event exists for a root Message, so the transcript is
  // the only thing that can tie the sent identity back to the Turn.
  const { container, emit, send } = await renderOwnershipProbe({
    send: async (_sessionId, command) => {
      admissionId = command.turnId;
      return pendingSend.promise;
    },
    readSettledMessages: async () => ({
      messages: admissionId
        ? [
            {
              type: 'user' as const,
              id: admissionId,
              turnId: 'unproven-root',
              ts: 1,
              text: 'reconcile me',
            },
          ]
        : [],
      settled: true,
    }),
  });

  let sendResult!: Promise<boolean>;
  await act(async () => {
    sendResult = send('reconcile me');
    await Promise.resolve();
  });
  await act(async () => {
    pendingSend.resolve({
      ok: false,
      reason: 'outcome_unknown',
      messageId: admissionId as string,
    });
    assert.equal(await sendResult, true);
    await Promise.resolve();
  });
  await act(async () => {
    emit(textDeltaEvent('unproven-text', 'unproven-root', 1, 'answer from the lost send'));
    await Promise.resolve();
  });
  await act(async () => {
    await Promise.resolve();
  });

  const probe = container.firstElementChild;
  assert.ok(probe);
  assert.equal(probe.getAttribute('data-live-turn-id'), 'unproven-root');
  assert.equal(probe.getAttribute('data-live-text'), 'answer from the lost send');
  assert.equal(probe.getAttribute('data-processing'), 'false');
});

test('clears a stopped Side Conversation admission when its live retraction is lost', async () => {
  let admissionId: string | undefined;
  const pendingStop = deferred<{ kind: 'retracted'; messageId: string }>();
  const pendingSend = deferred<{
    ok: true;
    steered: true;
    turnId: string;
    messageId: string;
  }>();
  const { container, send, stop } = await renderOwnershipProbe({
    send: async (_sessionId, command) => {
      admissionId = command.turnId;
      return pendingSend.promise;
    },
    stop: async (_sessionId, target) => {
      assert.deepEqual(target, { kind: 'admission', messageId: admissionId });
      return pendingStop.promise;
    },
  });

  let sendResult!: Promise<boolean>;
  await act(async () => {
    sendResult = send('stop this queued send');
    await Promise.resolve();
  });
  await waitUntil(() => admissionId !== undefined);
  let stopResult!: Promise<void>;
  await act(async () => {
    stopResult = stop();
    await Promise.resolve();
  });
  assert.equal(container.firstElementChild?.getAttribute('data-processing'), 'true');

  await act(async () => {
    pendingStop.resolve({ kind: 'retracted', messageId: admissionId as string });
    await stopResult;
    await Promise.resolve();
  });
  assert.equal(container.firstElementChild?.getAttribute('data-processing'), 'false');

  await act(async () => {
    pendingSend.resolve({
      ok: true,
      steered: true,
      turnId: 'old-turn',
      messageId: admissionId as string,
    });
    assert.equal(await sendResult, false);
    await Promise.resolve();
  });
  assert.equal(container.firstElementChild?.getAttribute('data-processing'), 'false');
  assert.equal(container.firstElementChild?.getAttribute('data-live-turn-id'), '');
});

test('keeps a Side Conversation admission when Host stop outcome is unknown', async () => {
  let admissionId: string | undefined;
  const pendingStop = deferred<undefined>();
  const { container, emit, send, stop } = await renderOwnershipProbe({
    send: async (_sessionId, command) => {
      admissionId = command.turnId;
      return {
        ok: false as const,
        reason: 'outcome_unknown' as const,
        messageId: admissionId as string,
      };
    },
    stop: async () => pendingStop.promise,
  });

  await act(async () => {
    assert.equal(await send('keep this admission'), true);
    await Promise.resolve();
  });
  let stopResult!: Promise<void>;
  await act(async () => {
    stopResult = stop();
    await Promise.resolve();
  });
  await act(async () => {
    emit(
      messageAdmittedEvent(
        'admitted-during-unknown-stop',
        'admitted-after-unknown-stop',
        1,
        admissionId as string,
      ),
    );
    emit(
      textDeltaEvent(
        'text-during-unknown-stop',
        'admitted-after-unknown-stop',
        2,
        'answer',
      ),
    );
    await Promise.resolve();
  });
  await act(async () => {
    pendingStop.reject(new Error('Host stop result is unknown'));
    await stopResult;
    await Promise.resolve();
  });
  await waitUntil(
    () =>
      container.firstElementChild?.getAttribute('data-live-turn-id') ===
      'admitted-after-unknown-stop',
  );
  assert.equal(
    container.firstElementChild?.getAttribute('data-live-turn-id'),
    'admitted-after-unknown-stop',
  );
  assert.equal(container.firstElementChild?.getAttribute('data-live-text'), 'answer');
  assert.equal(container.firstElementChild?.getAttribute('data-streaming'), 'true');
  assert.equal(container.firstElementChild?.getAttribute('data-processing'), 'false');
});

test('stops a bound Side Conversation by its exact Host Turn identity', async () => {
  let stoppedTarget: SideChatStopTarget;
  const { send, stop } = await renderOwnershipProbe({
    send: async () => ({ ok: true as const, turnId: 'host-turn-1' }),
    stop: async (_sessionId, target) => {
      stoppedTarget = target;
    },
  });
  await act(async () => {
    assert.equal(await send('start this exact turn'), true);
    await Promise.resolve();
  });
  await act(async () => {
    await stop();
    await Promise.resolve();
  });
  assert.deepEqual(stoppedTarget, { kind: 'turn', turnId: 'host-turn-1' });
});

test('releases a queued Side Conversation admission from the Host queue retract', async () => {
  let admissionId: string | undefined;
  const pendingSend = deferred<{
    ok: true;
    steered: true;
    turnId: string;
    messageId: string;
  }>();
  const { container, emit, send } = await renderOwnershipProbe({
    send: async (_sessionId, command) => {
      admissionId = command.turnId;
      return pendingSend.promise;
    },
  });

  let sendResult!: Promise<boolean>;
  await act(async () => {
    sendResult = send('retract this queued send');
    await Promise.resolve();
  });
  await awaitProcessing(container);
  assert.equal(container.firstElementChild?.getAttribute('data-processing'), 'true');

  await act(async () => {
    emit({
      type: 'message_admission',
      id: 'retracted-admission',
      turnId: 'old-turn',
      ts: 1,
      messageId: admissionId as string,
      outcome: 'retracted',
    });
    await Promise.resolve();
  });
  assert.equal(container.firstElementChild?.getAttribute('data-processing'), 'false');

  await act(async () => {
    pendingSend.resolve({
      ok: true,
      steered: true,
      turnId: 'not-the-owner',
      messageId: admissionId as string,
    });
    assert.equal(await sendResult, false);
    await Promise.resolve();
  });
  assert.equal(container.firstElementChild?.getAttribute('data-processing'), 'false');
});

test('keeps the same Side Conversation admission across a recoverable subscription error', async () => {
  let subscriptionCount = 0;
  const pendingSend = deferred<{ ok: true; turnId: string }>();
  const { container, emit, send } = await renderOwnershipProbe({
    subscribeEvents: (_sessionId, _handler, onSeeded) => {
      subscriptionCount += 1;
      onSeeded?.();
      return () => undefined;
    },
    send: async () => pendingSend.promise,
  });

  let sendResult!: Promise<boolean>;
  await act(async () => {
    sendResult = send('survive a recoverable stream error');
    await Promise.resolve();
  });
  await waitUntil(() => container.firstElementChild?.getAttribute('data-processing') === 'true');
  // The lazy fork subscribes exactly once, when the first send commits it.
  assert.equal(subscriptionCount, 1);
  await act(async () => {
    emit(recoverableErrorEvent('recoverable-subscription-error', 'old-turn', 1));
    await Promise.resolve();
  });
  assert.equal(container.firstElementChild?.getAttribute('data-processing'), 'true');
  assert.equal(subscriptionCount, 1);

  await act(async () => {
    pendingSend.resolve({ ok: true, turnId: 'late-turn' });
    assert.equal(await sendResult, true);
    await Promise.resolve();
  });
  await act(async () => {
    emit(completeEvent('late-complete', 'late-turn', 2));
    await Promise.resolve();
  });
  await waitUntil(() => container.firstElementChild?.getAttribute('data-processing') === 'false');
});

test('keeps the active Side Conversation streaming when Stop retracts a queued steer', async () => {
  const pendingSteer = deferred<{ kind: 'queued'; messageId: string }>();
  let admissionId: string | undefined;
  let steerCalls = 0;
  const { container, emit, send, steer, stop } = await renderOwnershipProbe({
    send: async () => ({ ok: true as const, turnId: 'old-turn' }),
    steer: async (_sessionId, _text, requestedAdmissionId) => {
      steerCalls += 1;
      admissionId = requestedAdmissionId;
      return pendingSteer.promise;
    },
    stop: async () => undefined,
  });

  await act(async () => {
    assert.equal(await send('initial prompt'), true);
    await Promise.resolve();
  });
  await waitUntil(() => container.firstElementChild?.getAttribute('data-streaming') === 'true');
  let steerResult!: Promise<boolean>;
  await act(async () => {
    steerResult = steer('queue this steer');
    await Promise.resolve();
  });
  await waitUntil(() => steerCalls === 1);
  assert.ok(admissionId);
  await act(async () => {
    await stop();
    await Promise.resolve();
  });
  assert.equal(container.firstElementChild?.getAttribute('data-live-turn-id'), 'old-turn');
  assert.equal(container.firstElementChild?.getAttribute('data-streaming'), 'true');

  await act(async () => {
    emit({
      type: 'message_admission',
      id: 'queued-steer-retracted',
      turnId: 'old-turn',
      ts: 1,
      messageId: admissionId as string,
      outcome: 'retracted',
    });
    await Promise.resolve();
  });
  assert.equal(container.firstElementChild?.getAttribute('data-streaming'), 'true');

  await act(async () => {
    pendingSteer.resolve({ kind: 'queued', messageId: admissionId as string });
    assert.equal(await steerResult, false);
    await Promise.resolve();
  });
});

test('stops the active Side Conversation after retracting its queued steer', async () => {
  const pendingSteer = deferred<{ kind: 'queued'; messageId: string }>();
  let admissionId: string | undefined;
  const stoppedTargets: SideChatStopTarget[] = [];
  const { send, steer, stop } = await renderOwnershipProbe({
    send: async () => ({ ok: true as const, turnId: 'old-turn' }),
    steer: async (_sessionId, _text, requestedAdmissionId) => {
      admissionId = requestedAdmissionId;
      return pendingSteer.promise;
    },
    stop: async (_sessionId, target) => {
      stoppedTargets.push(target);
      return target?.kind === 'admission' && target.messageId === admissionId
        ? { kind: 'retracted' as const, messageId: target.messageId }
        : undefined;
    },
  });

  await act(async () => {
    assert.equal(await send('initial prompt'), true);
    await Promise.resolve();
  });
  let steerResult!: Promise<boolean>;
  await act(async () => {
    steerResult = steer('queue this steer');
    await Promise.resolve();
  });
  await waitUntil(() => admissionId !== undefined);
  await act(async () => {
    await stop();
    await Promise.resolve();
  });
  await act(async () => {
    await stop();
    await Promise.resolve();
  });

  assert.deepEqual(stoppedTargets, [
    { kind: 'admission', messageId: admissionId },
    { kind: 'turn', turnId: 'old-turn' },
  ]);
  await act(async () => {
    pendingSteer.resolve({ kind: 'queued', messageId: admissionId as string });
    assert.equal(await steerResult, false);
    await Promise.resolve();
  });
});

test('does not let an older Stop failure release a newer active Turn Stop', async () => {
  const pendingSteer = deferred<{ kind: 'queued'; messageId: string }>();
  const queuedStop = deferred<undefined>();
  const activeStop = deferred<undefined>();
  let admissionId: string | undefined;
  const stoppedTargets: SideChatStopTarget[] = [];
  const { emit, send, steer, stop } = await renderOwnershipProbe({
    send: async () => ({ ok: true as const, turnId: 'old-turn' }),
    steer: async (_sessionId, _text, requestedAdmissionId) => {
      admissionId = requestedAdmissionId;
      return pendingSteer.promise;
    },
    stop: async (_sessionId, target) => {
      stoppedTargets.push(target);
      return stoppedTargets.length === 1 ? queuedStop.promise : activeStop.promise;
    },
  });

  await act(async () => {
    assert.equal(await send('initial prompt'), true);
    await Promise.resolve();
  });
  let steerResult!: Promise<boolean>;
  await act(async () => {
    steerResult = steer('queue this steer');
    await Promise.resolve();
  });
  await waitUntil(() => admissionId !== undefined);
  const queuedStopResult = stop();
  await act(async () => {
    emit({
      type: 'message_admission',
      id: 'queued-steer-retracted-before-stop-reply',
      turnId: 'old-turn',
      ts: 1,
      messageId: admissionId as string,
      outcome: 'retracted',
    });
    await Promise.resolve();
  });
  const activeStopResult = stop();
  await act(async () => {
    queuedStop.reject(new Error('old Stop reply was lost'));
    await queuedStopResult;
    await Promise.resolve();
  });
  const duplicateStopResult = stop();
  await Promise.resolve();

  assert.deepEqual(stoppedTargets, [
    { kind: 'admission', messageId: admissionId },
    { kind: 'turn', turnId: 'old-turn' },
  ]);
  activeStop.resolve(undefined);
  await Promise.all([activeStopResult, duplicateStopResult]);
  await act(async () => {
    pendingSteer.resolve({ kind: 'queued', messageId: admissionId as string });
    assert.equal(await steerResult, false);
    await Promise.resolve();
  });
});

test('continues projecting the active Turn while a steer awaits Host admission', async () => {
  const pendingSteer = deferred<{ kind: 'queued'; messageId: string }>();
  let admissionId: string | undefined;
  const { container, emit, send, steer } = await renderOwnershipProbe({
    send: async () => ({ ok: true as const, turnId: 'old-turn' }),
    steer: async (_sessionId, _text, requestedAdmissionId) => {
      admissionId = requestedAdmissionId;
      return pendingSteer.promise;
    },
  });

  await act(async () => {
    assert.equal(await send('initial prompt'), true);
    await Promise.resolve();
  });
  let steerResult!: Promise<boolean>;
  await act(async () => {
    steerResult = steer('queue this steer');
    await Promise.resolve();
  });
  await waitUntil(() => admissionId !== undefined);
  await act(async () => {
    emit(textDeltaEvent('old-turn-text', 'old-turn', 1, 'still streaming'));
    await Promise.resolve();
  });

  assert.equal(container.firstElementChild?.getAttribute('data-live-turn-id'), 'old-turn');
  assert.equal(container.firstElementChild?.getAttribute('data-live-text'), 'still streaming');
  assert.equal(container.firstElementChild?.getAttribute('data-streaming'), 'true');

  await act(async () => {
    pendingSteer.resolve({ kind: 'queued', messageId: admissionId as string });
    assert.equal(await steerResult, true);
    await Promise.resolve();
  });
});

test('fails a send when observation seed rejects and resubscribes for retry', async () => {
  let sendCalls = 0;
  let subscriptionCount = 0;
  let rejectSeed: ((error: unknown) => void) | undefined;
  let markSeeded: (() => void) | undefined;
  const { send } = await renderOwnershipProbe({
    subscribeEvents: (_sessionId, _handler, onSeeded, onSeedError) => {
      subscriptionCount += 1;
      if (subscriptionCount === 1) rejectSeed = onSeedError;
      else markSeeded = onSeeded;
      return () => undefined;
    },
    send: async () => {
      sendCalls += 1;
      return { ok: true as const, turnId: 'retry-turn' };
    },
  });

  let failedResult!: Promise<boolean>;
  await act(async () => {
    failedResult = send('observer failure');
    await Promise.resolve();
  });
  // The fork subscribes during the first send; fail that observation seed.
  await waitUntil(() => rejectSeed !== undefined);
  await act(async () => {
    rejectSeed?.(new Error('observer failed'));
    assert.equal(await failedResult, false);
  });
  assert.equal(sendCalls, 0);
  assert.equal(subscriptionCount, 2);
  assert.ok(markSeeded);

  await act(async () => {
    markSeeded?.();
    await Promise.resolve();
  });
  let retryResult!: Promise<boolean>;
  await act(async () => {
    retryResult = send('retry after observer failure');
    assert.equal(await retryResult, true);
  });
  assert.equal(sendCalls, 1);
});

test('releases a send waiting for observation when the Side Conversation is disposed', async () => {
  let sendCalls = 0;
  let unsubscribed = false;
  const { root, send } = await renderOwnershipProbe({
    subscribeEvents: () => () => {
      unsubscribed = true;
    },
    send: async () => {
      sendCalls += 1;
      return { ok: true as const, turnId: 'disposed-turn' };
    },
  });

  let sendResult!: Promise<boolean>;
  await act(async () => {
    sendResult = send('dispose while observing');
    await Promise.resolve();
  });
  await act(async () => {
    root.unmount();
    await Promise.resolve();
  });

  assert.equal(await sendResult, false);
  assert.equal(sendCalls, 0);
  assert.equal(unsubscribed, true);
  mountedRoot = undefined;
});

test('applies a permission mode picked before the first send once the fork is created', async () => {
  const permissionCalls: Array<{ sessionId: string; mode: PermissionMode }> = [];
  const probe = await renderOwnershipProbe({
    send: async () => ({ ok: true as const, turnId: 'turn-1' }),
    setPermissionMode: async (sessionId, mode) => {
      permissionCalls.push({ sessionId, mode });
      return { ...session('side-conversation'), permissionMode: mode };
    },
  });

  // No fork exists yet: the choice is staged and drives the read-only chip.
  await act(async () => {
    assert.equal(await probe.setPermissionMode('bypass'), true);
    await Promise.resolve();
  });
  const el = probe.container.firstElementChild;
  assert.equal(el?.getAttribute('data-permission-mode'), 'bypass');
  assert.equal(el?.getAttribute('data-companion-id'), '');
  assert.deepEqual(permissionCalls, []);

  // The first send creates the fork and applies the staged mode to it.
  await act(async () => {
    assert.equal(await probe.send('first message'), true);
    await Promise.resolve();
  });
  await waitUntil(() => permissionCalls.length === 1);
  assert.deepEqual(permissionCalls, [{ sessionId: 'side-conversation', mode: 'bypass' }]);
});

test('replaces a stale empty fork on the next send after the source model rebinds', async () => {
  const { sourceA, sourceB, forkB } = exactModelRebindScenario();
  let rejectSeed: ((error: unknown) => void) | undefined;
  let branchCount = 0;
  const cleaned: string[] = [];
  let currentSend!: (text: string) => Promise<boolean>;
  const rendered = await renderOwnershipProbe(
    {
      subscribeEvents: (sessionId, _handler, onSeeded, onSeedError) => {
        // The first fork's observation seed fails; the replacement seeds fine.
        if (sessionId === 'side-conversation') rejectSeed ??= onSeedError;
        else onSeeded?.();
        return () => undefined;
      },
      branchFromTurn: async () => {
        branchCount += 1;
        return {
          ok: true as const,
          session: branchCount === 1 ? session('side-conversation') : forkB,
        };
      },
      cleanupSessionCopy: async (sessionId) => {
        cleaned.push(sessionId);
      },
      send: async () => ({ ok: true as const, turnId: 'turn-1' }),
    },
    { sourceSession: sourceA, modelChoices: [choiceFor(sourceA)] },
  );
  currentSend = rendered.send;

  // The first send commits an (empty) fork, then its observation seed fails, so
  // the fork is retained with no content.
  let failed!: Promise<boolean>;
  await act(async () => {
    failed = currentSend('first message');
    await Promise.resolve();
  });
  await waitUntil(() => rejectSeed !== undefined);
  await act(async () => {
    rejectSeed?.(new Error('seed failed'));
    assert.equal(await failed, false);
  });
  const el = rendered.container.firstElementChild;
  assert.equal(el?.getAttribute('data-companion-id'), 'side-conversation');
  assert.equal(el?.getAttribute('data-model-ready'), 'true');

  // The source model rebinds; the empty fork's inherited model is now stale but
  // the composer stays usable, and the next send must replace the fork rather
  // than being wedged by the retained stale one.
  await rerenderOwnershipSource(rendered, sourceB, (send) => {
    currentSend = send;
  });
  assert.equal(el?.getAttribute('data-model-ready'), 'true');

  await act(async () => {
    assert.equal(await currentSend('retry after rebind'), true);
    await Promise.resolve();
  });
  await waitUntil(
    () => rendered.container.firstElementChild?.getAttribute('data-companion-id') === forkB.id,
  );
  assert.equal(branchCount, 2);
  assert.deepEqual(cleaned, ['side-conversation']);
});

test('fails closed when the staged permission write fails on the first send', async () => {
  let sendCalls = 0;
  const probe = await renderOwnershipProbe({
    send: async () => {
      sendCalls += 1;
      return { ok: true as const, turnId: 'turn-1' };
    },
    setPermissionMode: async () => {
      throw new Error('permission write failed');
    },
  });

  // Stage a stricter mode before the fork exists (source default is 'ask').
  await act(async () => {
    assert.equal(await probe.setPermissionMode('explore'), true);
    await Promise.resolve();
  });

  // The first send creates the fork; applying the staged mode fails, so the
  // send aborts WITHOUT dispatching the turn and keeps the staged choice.
  await act(async () => {
    assert.equal(await probe.send('do not run under the inherited mode'), false);
    await Promise.resolve();
  });
  assert.equal(sendCalls, 0);
  assert.equal(
    probe.container.firstElementChild?.getAttribute('data-permission-mode'),
    'explore',
  );
});

test('replays the empty copy point across an ambiguous retry even after the source settles', async () => {
  const sourceTurnIds: (string | undefined)[] = [];
  let listCount = 0;
  let branchCount = 0;
  const probe = await renderOwnershipProbe({
    listTurns: async () => {
      listCount += 1;
      return listCount === 1 ? [runningTurn('t1')] : [settledTurn('t1')];
    },
    branchFromTurn: async (_sessionId, input) => {
      sourceTurnIds.push(input.sourceTurnId);
      branchCount += 1;
      if (branchCount === 1) throw new Error('ambiguous outcome lost');
      return { ok: true as const, session: session('side-conversation') };
    },
    send: async () => ({ ok: true as const, turnId: 'turn-1' }),
  });

  // First send: only a running turn exists, so the fork is empty — but the
  // branch's outcome is lost (throws), leaving the retry lease open.
  await act(async () => {
    assert.equal(await probe.send('first attempt'), false);
    await Promise.resolve();
  });
  // Second send: the source has since settled a turn, but the retry must REPLAY
  // the empty copy point (same copyId) instead of switching to through_turn,
  // or the Host fingerprint would reject the reused identity.
  await act(async () => {
    await probe.send('retry');
    await Promise.resolve();
  });
  await waitUntil(() => branchCount === 2);
  assert.deepEqual(sourceTurnIds, [undefined, undefined]);
});

test('declining Full access through the side-chat hook does not persist the permission mode', async () => {
  let confirmations = 0;
  let writes = 0;
  let setPermissionMode!: (mode: PermissionMode) => Promise<boolean>;

  const { container } = await renderProbe(
    {
      setPermissionMode: async (sessionId, mode) => {
        writes += 1;
        return session(sessionId, { permissionMode: mode });
      },
    },
    {
      confirmBypass: async () => {
        confirmations += 1;
        return false;
      },
      onSetPermissionMode: (setter) => {
        setPermissionMode = setter;
      },
    },
  );

  assert.ok(container.firstElementChild);
  const result = await act(async () => setPermissionMode('bypass'));

  assert.equal(result, false);
  assert.equal(confirmations, 1);
  assert.equal(writes, 0);
});

function QuoteCompanionProbe(props: {
  sourceSession?: SessionSummary;
  modelChoices?: readonly ChatModelChoice[];
  onSetPermissionMode?: (setPermissionMode: (mode: PermissionMode) => Promise<boolean>) => void;
  confirmBypass?: () => Promise<boolean>;
}) {
  const sourceSession = props.sourceSession ?? SOURCE_SESSION;
  const companion = useQuoteCompanion({
    panelId: 'retry-panel',
    pendingQuotes: [],
    sourceSession,
    modelChoices: props.modelChoices ?? [choiceFor(sourceSession)],
    locale: 'en',
    onQuotesConsumed: () => undefined,
    confirmBypass: props.confirmBypass ?? (async () => true),
  });
  props.onSetPermissionMode?.(companion.setPermissionMode);
  return createElement('div', {
    'data-error': companion.error ?? '',
    'data-companion-id': companion.companionSession?.id ?? '',
  }, companion.error);
}

function QuoteCompanionOwnershipProbe(props: {
  onSend: (send: (text: string) => Promise<boolean>) => void;
  onSteer?: (steer: (text: string) => Promise<boolean>) => void;
  onStop?: (stop: () => Promise<void>) => void;
  onSetPermissionMode?: (set: (mode: PermissionMode) => Promise<boolean>) => void;
  onContextCompactionError?: (sessionId: string, error: unknown) => void;
  pendingQuotes?: readonly StagedCompanionQuote[];
  onQuotesConsumed?: (snapshot: CompanionQuoteSnapshot) => void;
  sourceSession?: SessionSummary;
  modelChoices?: readonly ChatModelChoice[];
}) {
  const sourceSession = props.sourceSession ?? SOURCE_SESSION;
  const companion = useQuoteCompanion({
    panelId: 'ownership-panel',
    pendingQuotes: props.pendingQuotes ?? [],
    sourceSession,
    modelChoices: props.modelChoices ?? [choiceFor(sourceSession)],
    locale: 'en',
    onQuotesConsumed: props.onQuotesConsumed ?? (() => undefined),
    confirmBypass: async () => true,
    onContextCompactionError: props.onContextCompactionError,
  });
  props.onSend(companion.send);
  props.onSteer?.(companion.steer);
  props.onStop?.(companion.stop);
  props.onSetPermissionMode?.(companion.setPermissionMode);
  return createElement('div', {
    'data-companion-id': companion.companionSession?.id ?? '',
    'data-error': companion.error ?? '',
    'data-live-turn-id': companion.liveTurn?.turnId ?? '',
    'data-live-text': companion.liveTurn?.steps.find((step) => step.text)?.text?.text ?? '',
    'data-streaming': String(companion.streaming),
    'data-processing': String(companion.processing),
    'data-model-ready': String(companion.modelReady),
    'data-permission-mode': companion.permissionMode ?? '',
    'data-transient-count': String(companion.transientMessages.length),
    'data-transient-text': companion.transientMessages[0]?.text ?? '',
  });
}

function session(id: string, overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id,
    name: id,
    isFlagged: false,
    isArchived: false,
    labels: [],
    hasUnread: false,
    status: 'active',
    backend: 'ai-sdk',
    llmConnectionId: 'connection-1',
    llmConnectionSlug: 'test',
    connectionLocked: false,
    model: 'test-model',
    permissionMode: 'ask',
    ...overrides,
  };
}

function choiceFor(
  source: SessionSummary,
  overrides: Partial<ChatModelChoice> = {},
): ChatModelChoice {
  assert.ok(source.llmConnectionId);
  return {
    connectionId: source.llmConnectionId,
    connectionSlug: source.llmConnectionSlug,
    providerType: 'openai',
    providerLabel: 'OpenAI',
    model: source.model,
    label: source.model,
    isDefault: true,
    thinkingLevels: [],
    ...overrides,
  };
}

function settledTurn(turnId: string): TurnRecord {
  return { turnId, status: 'completed', partialOutputRetained: false };
}

function runningTurn(turnId: string): TurnRecord {
  return { turnId, status: 'running', partialOutputRetained: false };
}

async function waitUntil(predicate: () => boolean, diagnostics?: () => string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await act(async () => {
      await new Promise<void>((resolve) => setImmediate(resolve));
    });
  }
  assert.fail(
    `Timed out waiting for the Side Conversation state${diagnostics ? ` (${diagnostics()})` : ''}`,
  );
}

// The fork is created lazily during the first send. Emitting fork events (or
// stopping) before that fork commits would race a not-yet-established
// subscription, so tests await the committed companion first.
async function awaitCompanion(container: Element, id = 'side-conversation'): Promise<void> {
  await waitUntil(() => container.firstElementChild?.getAttribute('data-companion-id') === id);
}

// A live-turn admission is armed only once the send reaches its optimistic
// dispatch, which is a stricter barrier than the fork merely committing.
async function awaitProcessing(container: Element): Promise<void> {
  await waitUntil(() => container.firstElementChild?.getAttribute('data-processing') === 'true');
}
