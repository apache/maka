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
import type { SessionChangedEvent, SessionSummary, TurnRecord } from '@maka/core/session';
import {
  createFakeWorkbarServices,
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
    onSetPermissionMode?: (setPermissionMode: (mode: PermissionMode) => Promise<boolean>) => void;
    confirmBypass?: () => Promise<boolean>;
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
      options.ready?.(container) ??
      container.firstElementChild?.getAttribute('data-companion-id') === 'side-conversation',
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
  } = {},
) {
  let send!: (text: string) => Promise<boolean>;
  let steer!: (text: string) => Promise<boolean>;
  let stop!: () => Promise<void>;
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
      ...options,
    },
  );
  return {
    ...rendered,
    send: (text: string) => send(text),
    steer: (text: string) => steer(text),
    stop: () => stop(),
    emit(event: SessionEvent) {
      assert.ok(eventHandler);
      eventHandler(event);
    },
  };
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

test('retries a busy Side Conversation at the newest settled boundary and clears its banner', async () => {
  let listCount = 0;
  let sessionChange: ((event: SessionChangedEvent) => void) | undefined;
  let releaseRetry: (() => void) | undefined;
  const branchInputs: Array<{ sourceTurnId: string; copyId: string }> = [];
  const { container } = await renderProbe(
    {
      listTurns: async () => {
        listCount += 1;
        return listCount === 1
          ? [settledTurn('turn-before-busy')]
          : [settledTurn('turn-before-busy'), settledTurn('turn-after-busy')];
      },
      branchFromTurn: async (_sessionId, input) => {
        branchInputs.push({ sourceTurnId: input.sourceTurnId, copyId: input.copyId });
        if (branchInputs.length === 1) {
          return { ok: false as const, reason: 'session_busy' as const };
        }
        await new Promise<void>((resolve) => {
          releaseRetry = resolve;
        });
        return { ok: true as const, session: session('side-conversation') };
      },
      subscribeSessionChanges: (handler) => {
        sessionChange = handler;
        return () => {
          if (sessionChange === handler) sessionChange = undefined;
        };
      },
    },
    { ready: () => branchInputs.length === 1 && sessionChange !== undefined },
  );
  assert.match(container.textContent, /main conversation or a linked task is still running/i);
  const probe = container.firstElementChild;
  assert.ok(probe);

  await act(async () => {
    sessionChange?.({
      reason: 'turn-status-change',
      sessionId: 'source-session',
      turnId: 'turn-after-busy',
      ts: Date.now(),
    });
    await Promise.resolve();
  });
  await waitUntil(() => branchInputs.length === 2 && releaseRetry !== undefined);
  assert.equal(probe.getAttribute('data-preparing'), 'false');
  assert.match(container.textContent, /main conversation or a linked task is still running/i);

  await act(async () => {
    releaseRetry?.();
    await Promise.resolve();
  });
  await waitUntil(
    () => probe.getAttribute('data-companion-id') === 'side-conversation',
    () =>
      `branch inputs: ${JSON.stringify(branchInputs)}; companion: ${probe.getAttribute('data-companion-id')}; error: ${probe.getAttribute('data-error')}`,
  );

  assert.deepEqual(
    branchInputs.map(({ sourceTurnId }) => sourceTurnId),
    ['turn-before-busy', 'turn-after-busy'],
  );
  assert.notEqual(branchInputs[0]?.copyId, branchInputs[1]?.copyId);
  assert.equal(probe.getAttribute('data-error'), '');
});

test('does not restart foreground setup when the source Session object refreshes', async () => {
  let branchCount = 0;
  const { container, root, services } = await renderProbe(
    {
      listTurns: async () => [settledTurn('settled-turn')],
      branchFromTurn: async () => {
        branchCount += 1;
        if (branchCount === 1) {
          return { ok: false as const, reason: 'session_busy' as const };
        }
        return await new Promise<never>(() => undefined);
      },
    },
    { sourceSession: session('source-session'), ready: () => branchCount === 1 },
  );
  const probe = container.firstElementChild;
  assert.ok(probe);
  await waitUntil(
    () => branchCount === 1 && probe.getAttribute('data-preparing') === 'false',
  );

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

  assert.equal(branchCount, 1);
  assert.equal(probe.getAttribute('data-preparing'), 'false');
});

test('waits for the source model to become available before forking', async () => {
  let branchCount = 0;
  const { container, root, services } = await renderProbe(
    {
      listTurns: async () => [settledTurn('settled-turn')],
      branchFromTurn: async () => {
        branchCount += 1;
        return { ok: true as const, session: session('side-conversation') };
      },
    },
    {
      sourceSession: session('source-session'),
      modelChoices: [],
      ready: (current) =>
        current.firstElementChild?.getAttribute('data-preparing') === 'false',
    },
  );
  const probe = container.firstElementChild;
  assert.ok(probe);
  assert.equal(branchCount, 0);
  assert.equal(probe.getAttribute('data-companion-id'), '');

  await rerenderProbeSource({ root, services }, session('source-session'));
  await waitUntil(() => probe.getAttribute('data-companion-id') === 'side-conversation');

  assert.equal(branchCount, 1);
});

test('replaces an empty companion whose exact model is no longer available', async () => {
  const { sourceA, sourceB, forkB } = exactModelRebindScenario();
  let branchCount = 0;
  const cleaned: string[] = [];
  const { container, root, services } = await renderProbe(
    {
      branchFromTurn: async () => {
        branchCount += 1;
        return {
          ok: true as const,
          session: branchCount === 1 ? session('side-conversation-a') : forkB,
        };
      },
      cleanupSessionCopy: async (sessionId) => {
        cleaned.push(sessionId);
      },
    },
    {
      sourceSession: sourceA,
      modelChoices: [choiceFor(sourceA)],
      ready: (current) =>
        current.firstElementChild?.getAttribute('data-companion-id') ===
        'side-conversation-a',
    },
  );
  const probe = container.firstElementChild;
  assert.ok(probe);

  await rerenderProbeSource({ root, services }, sourceB);
  await waitUntil(() => probe.getAttribute('data-companion-id') === forkB.id);

  assert.equal(branchCount, 2);
  assert.deepEqual(cleaned, ['side-conversation-a']);
});

test('does not commit a fork whose model becomes unavailable during setup', async () => {
  const source = session('source-session');
  const pendingFork = deferred<SessionSummary>();
  const cleaned: string[] = [];
  let branchCount = 0;
  const { container, root, services } = await renderProbe(
    {
      branchFromTurn: async () => {
        branchCount += 1;
        return { ok: true as const, session: await pendingFork.promise };
      },
      cleanupSessionCopy: async (sessionId) => {
        cleaned.push(sessionId);
      },
    },
    {
      sourceSession: source,
      modelChoices: [choiceFor(source)],
      ready: () => branchCount === 1,
    },
  );
  const probe = container.firstElementChild;
  assert.ok(probe);

  await act(async () => {
    root.render(probeTree(services, source, []));
    pendingFork.resolve(session('side-conversation-a'));
    await pendingFork.promise;
  });
  await waitUntil(() => probe.getAttribute('data-preparing') === 'false');

  assert.equal(probe.getAttribute('data-companion-id'), '');
  assert.deepEqual(cleaned, ['side-conversation-a']);
});

test('does not replace a fork while its send waits for observation readiness', async () => {
  const { sourceA, sourceB, forkB } = exactModelRebindScenario();
  let branchCount = 0;
  let seedA: (() => void) | undefined;
  const cleaned: string[] = [];
  const sendTargets: string[] = [];
  let currentSend!: (text: string) => Promise<boolean>;
  const rendered = await renderOwnershipProbe(
    {
      branchFromTurn: async () => {
        branchCount += 1;
        return {
          ok: true as const,
          session: branchCount === 1 ? session('side-conversation') : forkB,
        };
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
    rendered.root.render(ownershipProbeTree(rendered.services, sourceB, (send) => {
      currentSend = send;
    }));
    await Promise.resolve();
  });
  assert.deepEqual(cleaned, [], 'the send lock must retain its fork');

  await act(async () => {
    seedA?.();
    assert.equal(await firstSend, false);
  });
  assert.deepEqual(sendTargets, ['side-conversation']);
  const probe = rendered.container.firstElementChild;
  assert.ok(probe);
  await waitUntil(() => probe.getAttribute('data-companion-id') === forkB.id);
  assert.deepEqual(cleaned, ['side-conversation']);
  assert.equal(branchCount, 2);

  await act(async () => {
    assert.equal(await currentSend('retry after rebind'), false);
  });
  assert.deepEqual(sendTargets, ['side-conversation', 'side-conversation-b']);
});

test('replaces an empty stale fork after its pending admission is retracted', async () => {
  const { sourceA, sourceB, forkB } = exactModelRebindScenario();
  const pendingSend = deferred<{
    ok: true;
    steered: true;
    turnId: string;
    messageId: string;
  }>();
  let admissionId: string | undefined;
  let branchCount = 0;
  const cleaned: string[] = [];
  let currentSend!: (text: string) => Promise<boolean>;
  const rendered = await renderOwnershipProbe(
    {
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
      send: async (_sessionId, command) => {
        admissionId = command.turnId;
        return pendingSend.promise;
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
    sendResult = currentSend('pending send');
    await Promise.resolve();
  });
  await waitUntil(() => admissionId !== undefined);
  await rerenderOwnershipSource(rendered, sourceB, (send) => { currentSend = send; });
  assert.deepEqual(cleaned, [], 'pending admission must retain its fork');

  await act(async () => {
    rendered.emit({
      type: 'message_admission',
      id: 'retracted-after-rebind',
      turnId: 'old-turn',
      ts: 1,
      messageId: admissionId as string,
      outcome: 'retracted',
    });
    await Promise.resolve();
  });
  const probe = rendered.container.firstElementChild;
  assert.ok(probe);
  await waitUntil(() => probe.getAttribute('data-companion-id') === forkB.id);
  assert.deepEqual(cleaned, ['side-conversation']);
  assert.equal(branchCount, 2);

  await act(async () => {
    pendingSend.resolve({
      ok: true,
      steered: true,
      turnId: 'old-turn',
      messageId: admissionId as string,
    });
    assert.equal(await sendResult, false);
  });
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
  assert.equal(subscriptionCount, 1);

  let sendResult!: Promise<boolean>;
  await act(async () => {
    sendResult = send('survive a recoverable stream error');
    await Promise.resolve();
  });
  await waitUntil(() => container.firstElementChild?.getAttribute('data-processing') === 'true');
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
  assert.ok(rejectSeed);

  let failedResult!: Promise<boolean>;
  await act(async () => {
    failedResult = send('observer failure');
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
    'data-preparing': String(companion.preparing),
  }, companion.error);
}

function QuoteCompanionOwnershipProbe(props: {
  onSend: (send: (text: string) => Promise<boolean>) => void;
  onSteer?: (steer: (text: string) => Promise<boolean>) => void;
  onStop?: (stop: () => Promise<void>) => void;
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
  });
  props.onSend(companion.send);
  props.onSteer?.(companion.steer);
  props.onStop?.(companion.stop);
  return createElement('div', {
    'data-companion-id': companion.companionSession?.id ?? '',
    'data-error': companion.error ?? '',
    'data-live-turn-id': companion.liveTurn?.turnId ?? '',
    'data-live-text': companion.liveTurn?.steps.find((step) => step.text)?.text?.text ?? '',
    'data-streaming': String(companion.streaming),
    'data-processing': String(companion.processing),
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
