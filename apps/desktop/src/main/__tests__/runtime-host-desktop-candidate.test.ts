import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import type { IpcMain } from 'electron';
import type {
  BotIncomingMessage,
  BotRegistry,
  ComputerUseToolSet,
  MakaTool,
} from '@maka/runtime';
import type { ClientCapabilityProvider, RuntimeHostConnection } from '@maka/runtime-host/client';
import type {
  ClientCapabilityCallFrame,
  OperationInput,
  OperationKey,
  SessionCatalogProjection,
  SessionContinuitySnapshot,
  SubscriptionFrame,
} from '@maka/runtime-host/protocol';
import { z } from 'zod';
import { createAttachmentApprovalRegistry } from '../attachment-approval.js';
import {
  createDesktopRuntimeHostCandidate,
  type DesktopRuntimeHostCandidateControls,
  type DesktopRuntimeHostCandidateDeps,
} from '../runtime-host-desktop-candidate.js';
import { RuntimeHostSessionObservationRegistry } from '../runtime-host-session-observation-registry.js';

test('owns one complete Desktop candidate generation and can restart cleanly', async () => {
  const ipc = ipcHarness();
  const first = connectionHarness('first');
  const candidate = await createDesktopRuntimeHostCandidate(first.connection, deps(ipc));

  assert.equal(first.capabilityRegistrations, 1);
  assert.deepEqual(
    ((await ipc.invoke('sessions:list')) as SessionCatalogProjection[]).map(({ id }) => id),
    ['session-first'],
  );
  assert.deepEqual(await ipc.invoke('external-sessions:listSources'), {
    adapterIds: ['codex'],
  });
  assert.deepEqual(await ipc.invoke('shell-runs:list', 'session-first'), []);
  assert.deepEqual(await ipc.invoke('sessions:readExecutionBoundary', 'session-first'), {
    kind: 'managed',
    access: 'read_only',
    revision: 1,
  });

  await candidate.close();
  assert.equal(ipc.size, 0);
  assert.equal(first.capabilityUnregistrations, 1);
  assert.equal(first.closeCalls, 1);

  const second = connectionHarness('second');
  const reconnected = await createDesktopRuntimeHostCandidate(second.connection, deps(ipc));
  assert.deepEqual(
    ((await ipc.invoke('sessions:list')) as SessionCatalogProjection[]).map(({ id }) => id),
    ['session-second'],
  );
  await reconnected.close();
  assert.equal(ipc.size, 0);
});

test('tears down the whole candidate when the Host connection closes', async () => {
  const ipc = ipcHarness();
  const host = connectionHarness('closed');
  const candidate = await createDesktopRuntimeHostCandidate(host.connection, deps(ipc));

  host.disconnect();
  await Promise.resolve();
  assert.equal(ipc.size, 0);
  await candidate.closed;

  assert.equal(host.closeCalls, 1);
});

test('disposes candidate-scoped product IPC state on reconnect teardown', async () => {
  const ipc = ipcHarness();
  const host = connectionHarness('client-ipc');
  let disposeCalls = 0;
  const candidate = await createDesktopRuntimeHostCandidate(host.connection, {
    ...deps(ipc),
    registerClientIpc: () => () => {
      disposeCalls += 1;
    },
  });

  await candidate.close();
  await candidate.close();

  assert.equal(disposeCalls, 1);
});

test('starts without registering an empty native capability set', async () => {
  const ipc = ipcHarness();
  const host = connectionHarness('no-capabilities');
  const candidate = await createDesktopRuntimeHostCandidate(
    host.connection,
    deps(ipc, {
      browserTools: [],
      releaseBrowserSession() {},
      computerUseTools: emptyComputerUseTools(),
      releaseComputerUseSession() {},
    }),
  );

  assert.equal(host.capabilityRegistrations, 0);
  await candidate.close();
  assert.equal(host.capabilityUnregistrations, 0);
});

test('refreshes native capabilities with a new immutable provider snapshot', async () => {
  const ipc = ipcHarness();
  const host = connectionHarness('capability-refresh');
  let controls: DesktopRuntimeHostCandidateControls | undefined;
  let implementation = 'old';
  const candidate = await createDesktopRuntimeHostCandidate(host.connection, {
    ...deps(ipc, {
      browserTools: [],
      releaseBrowserSession() {},
      computerUseTools: emptyComputerUseTools(),
      releaseComputerUseSession() {},
      additionalGroups: () => {
        const value = implementation;
        return [
          {
            offerId: 'desktop_mcp',
            label: 'MCP',
            description: 'MCP tools',
            tools: [
              {
                ...nativeTool(),
                name: 'mcp_snapshot',
                impl: async () => value,
              },
            ],
          },
        ];
      },
    }),
    registerClientIpc: (_client, _ipc, nextControls) => {
      controls = nextControls;
    },
  });
  const frame = {
    ...capabilityFrame('session-refresh'),
    offerId: 'desktop_mcp',
    serverId: 'desktop_mcp',
    toolName: 'mcp_snapshot',
  };

  assert.deepEqual(await host.invokeCapability(frame), {
    content: [{ type: 'text', text: 'old' }],
  });
  implementation = 'new';
  await controls?.refreshClientCapabilities();
  assert.equal(host.capabilityRegistrations, 2);
  assert.deepEqual(await host.invokeCapability(frame), {
    content: [{ type: 'text', text: 'new' }],
  });

  await candidate.close();
});

test('releases all native Session resources on retirement and generation close', async () => {
  const ipc = ipcHarness();
  const host = connectionHarness('native-lifecycle');
  const browserReleased: string[] = [];
  const computerReleased: string[] = [];
  const candidate = await createDesktopRuntimeHostCandidate(
    host.connection,
    deps(ipc, {
      browserTools: [nativeTool()],
      releaseBrowserSession: async (sessionId) => {
        browserReleased.push(sessionId);
      },
      computerUseTools: emptyComputerUseTools(),
      releaseComputerUseSession: (sessionId) => {
        computerReleased.push(sessionId);
      },
    }),
  );

  await host.invokeCapability(capabilityFrame('session-native-lifecycle'));
  await ipc.invoke('sessions:archive', 'session-native-lifecycle');
  assert.deepEqual(browserReleased, ['session-native-lifecycle']);
  assert.deepEqual(computerReleased, ['session-native-lifecycle']);

  await host.invokeCapability(capabilityFrame('close-owned-session'));
  await candidate.close();
  assert.deepEqual(browserReleased, ['session-native-lifecycle', 'close-owned-session']);
  assert.deepEqual(computerReleased, ['session-native-lifecycle', 'close-owned-session']);
});

test('drains an accepted Host-backed Bot turn before closing its generation', async () => {
  const ipc = ipcHarness();
  const host = connectionHarness('bot');
  const replies: string[] = [];
  const input = {
    ...deps(ipc),
    botRegistry: {
      sendMessage: async (_platform: unknown, _chatId: unknown, text: string) => {
        replies.push(text);
        return null;
      },
      sendTypingIndicator: async () => false,
    } as unknown as BotRegistry,
  };
  const candidate = await createDesktopRuntimeHostCandidate(host.connection, input);

  const accepted = candidate.botIncoming.handleBotIncomingMessage({
    platform: 'telegram',
    userId: 'user',
    userName: 'User',
    chatId: 'chat',
    isGroup: false,
    text: 'answer this',
    sourceMessageId: 'source-1',
    receivedAt: 1,
  } as BotIncomingMessage);
  await host.turnStarted;

  await candidate.close();
  await accepted;
  assert.deepEqual(replies, []);
  assert.equal(host.startTurnCalls, 1);

  await candidate.botIncoming.handleBotIncomingMessage({
    platform: 'telegram',
    userId: 'user',
    userName: 'User',
    chatId: 'chat',
    isGroup: false,
    text: 'must not start',
    sourceMessageId: 'source-2',
    receivedAt: 2,
  } as BotIncomingMessage);
  assert.equal(host.startTurnCalls, 1);
});

test('rolls back only candidate-owned IPC after a registration collision', async () => {
  const ipc = ipcHarness();
  ipc.handle('deepResearch:get', async () => 'embedded');
  const host = connectionHarness('collision');

  await assert.rejects(
    () => createDesktopRuntimeHostCandidate(host.connection, deps(ipc)),
    /duplicate handler: deepResearch:get/,
  );

  assert.equal(await ipc.invoke('deepResearch:get'), 'embedded');
  assert.deepEqual(ipc.channels, ['deepResearch:get']);
  assert.equal(host.closeCalls, 1);
});

test('closes the claimed Host connection when native capability construction fails', async () => {
  const ipc = ipcHarness();
  const host = connectionHarness('invalid-capability');
  const invalidTool = {
    ...nativeTool(),
    parameters: z.string(),
  } as unknown as MakaTool;

  await assert.rejects(
    () =>
      createDesktopRuntimeHostCandidate(
        host.connection,
        deps(ipc, {
          browserTools: [invalidTool],
          releaseBrowserSession() {},
          computerUseTools: emptyComputerUseTools(),
          releaseComputerUseSession() {},
        }),
      ),
    /tool schema must be an object/,
  );

  assert.equal(ipc.size, 0);
  assert.equal(host.closeCalls, 1);
});

test('does not release or report a Revision the Host retained during cleanup', async () => {
  const ipc = ipcHarness();
  const host = connectionHarness('retained-revision', { revisionAbandon: 'retained' });
  const released: string[] = [];
  const changes: Array<{ reason: string; sessionId?: string }> = [];
  let removeSessionCopy: ((sessionId: string) => Promise<'removed' | 'retained'>) | undefined;
  const candidate = await createDesktopRuntimeHostCandidate(host.connection, {
    ...deps(ipc, {
      browserTools: [],
      releaseBrowserSession: (sessionId) => {
        released.push(`browser:${sessionId}`);
      },
      computerUseTools: emptyComputerUseTools(),
      releaseComputerUseSession: (sessionId) => {
        released.push(`computer:${sessionId}`);
      },
    }),
    emitSessionsChanged: (reason, sessionId) => changes.push({ reason, sessionId }),
    createSessionCopyCleanup: ({ removeSession }) => {
      removeSessionCopy = removeSession;
      return {
        ownCreation: (_creation, operation) => operation(),
        cleanup: async () => undefined,
        schedule: async () => undefined,
        abandonOwner: async () => undefined,
        recover: async () => ({ removed: [], failed: [] }),
      };
    },
  });

  assert.ok(removeSessionCopy);
  assert.equal(await removeSessionCopy('session-retained-revision'), 'retained');
  assert.deepEqual(released, []);
  assert.deepEqual(changes, []);
  await candidate.close();
});

test('resyncs Goal, exact interaction, and sidecar state after candidate replacement', async () => {
  const ref = 'maka://runtime/background-tasks/shell-1';
  const observations = new RuntimeHostSessionObservationRegistry();
  const firstIpc = ipcHarness();
  const firstHost = connectionHarness('first-observer', {
    subscriptionSnapshot: continuitySnapshot({
      interactions: { pending: [pendingQuestion()] },
    }),
    runtimeResourcePty: ptySnapshot(ref, 'before replacement'),
  });
  const firstCandidate = await createDesktopRuntimeHostCandidate(
    firstHost.connection,
    deps(firstIpc),
    observations,
  );
  await firstIpc.invoke('sessions:observe', 'session-1', 'observer-1');
  assert.ok(
    firstIpc.sender.sent.some(
      ({ payload }) =>
        (payload as { type?: unknown }).type === 'user_question_request',
    ),
  );
  assert.equal(
    (
      (await firstIpc.invoke('shell-runs:attach', {
        sessionId: 'session-1',
        ref,
      })) as { buffer: string }
    ).buffer,
    'before replacement',
  );
  await firstCandidate.close();

  const secondIpc = ipcHarness();
  const resyncs: Array<{ channel: string; payload: unknown }> = [];
  const sessionChanges: Array<{ reason: string; sessionId?: string }> = [];
  let terminalReattach: Promise<unknown> | undefined;
  const secondHost = connectionHarness('second-observer', {
    subscriptionSnapshot: continuitySnapshot({ interactions: { pending: [] } }),
    runtimeResourcePty: ptySnapshot(ref, 'after replacement'),
  });
  const secondCandidate = await createDesktopRuntimeHostCandidate(
    secondHost.connection,
    {
      ...deps(secondIpc),
      emitSessionsChanged: (reason, sessionId) =>
        sessionChanges.push({ reason, sessionId }),
      sendToRenderer: (channel, payload) => {
        resyncs.push({ channel, payload });
        if (channel === 'shell-runs:resync') {
          terminalReattach ??= secondIpc.invoke('shell-runs:attach', {
            sessionId: 'session-1',
            ref,
          });
        }
      },
    },
    observations,
  );

  assert.ok(
    resyncs.some(
      ({ channel, payload }) =>
        channel === 'graphs:resync' &&
        (payload as { rootSessionId?: unknown }).rootSessionId === 'session-1',
    ),
  );
  assert.ok(
    sessionChanges.some(
      ({ reason, sessionId }) =>
        reason === 'goal-change' && sessionId === 'session-1',
    ),
  );
  assert.ok(
    resyncs.some(
      ({ channel, payload }) =>
        channel === 'shell-runs:resync' &&
        (payload as { sessionId?: unknown }).sessionId === 'session-1',
    ),
  );
  assert.ok(
    resyncs.some(
      ({ channel, payload }) =>
        channel === 'sessions:active-interactions-changed' &&
        (payload as { sessionId?: unknown }).sessionId === 'session-1' &&
        Array.isArray((payload as { interactions?: unknown }).interactions) &&
        (payload as { interactions: unknown[] }).interactions.length === 0,
    ),
  );
  assert.ok(terminalReattach);
  assert.equal(
    ((await terminalReattach) as { buffer: string }).buffer,
    'after replacement',
  );
  assert.equal(secondHost.runtimeResourceControllerAcquires, 1);

  secondHost.pushSubscriptionFrame({
    kind: 'subscription.runtime_resource_pty_data',
    hostEpoch: 'host-second-observer',
    subscriptionId: 'subscription-second-observer',
    sequence: 1,
    sessionId: 'session-1',
    ref,
    ptySequence: 5,
    data: ' live',
  });
  await waitFor(() =>
    resyncs.some(
      ({ channel, payload }) =>
        channel === 'shell-runs:pty-data' &&
        (payload as { sequence?: unknown }).sequence === 5 &&
        (payload as { data?: unknown }).data === ' live',
    ),
  );

  await secondCandidate.close();
  await observations.close();
});

type IpcHandler = Parameters<Pick<IpcMain, 'handle'>['handle']>[1];

function ipcHarness() {
  const handlers = new Map<string, IpcHandler>();
  const sender = Object.assign(new EventEmitter(), {
    id: 1,
    sent: [] as Array<{ channel: string; payload: unknown }>,
    send(channel: string, payload: unknown): void {
      sender.sent.push({ channel, payload });
    },
  });
  return {
    handle(channel: string, handler: IpcHandler): void {
      if (handlers.has(channel)) throw new Error(`duplicate handler: ${channel}`);
      handlers.set(channel, handler);
    },
    removeHandler(channel: string): void {
      handlers.delete(channel);
    },
    async invoke(channel: string, ...args: unknown[]): Promise<unknown> {
      const handler = handlers.get(channel);
      assert.ok(handler, `missing handler: ${channel}`);
      return handler({ sender } as never, ...args);
    },
    get channels(): string[] {
      return [...handlers.keys()].sort();
    },
    get size(): number {
      return handlers.size;
    },
    sender,
  };
}

function deps(
  ipcMain: ReturnType<typeof ipcHarness>,
  nativeCapabilities: DesktopRuntimeHostCandidateDeps['nativeCapabilities'] = {
    browserTools: [nativeTool()],
    releaseBrowserSession() {},
    computerUseTools: emptyComputerUseTools(),
    releaseComputerUseSession() {},
  },
): DesktopRuntimeHostCandidateDeps {
  return {
    ipcMain,
    workspaceRoot: '/workspace',
    attachmentApprovals: createAttachmentApprovalRegistry(),
    stat: async () => ({ size: 0 }),
    resizeImage: async (bytes) => bytes,
    nativeCapabilities,
    botRegistry: {} as BotRegistry,
    resolveBotCreateTarget: async () => ({ cwd: '/workspace' }),
    resolveSessionCreateProject: async () => ({ cwd: '/workspace' }),
    emitSessionsChanged() {},
    emitModeChanged() {},
    completeComputerUseTurn() {},
    createSessionCopyCleanup: () => ({
      ownCreation: (_creation, operation) => operation(),
      cleanup: async () => undefined,
      schedule: async () => undefined,
      abandonOwner: async () => undefined,
      recover: async () => ({ removed: [], failed: [] }),
    }),
    newId: () => 'candidate-id',
  };
}

function emptyComputerUseTools(): ComputerUseToolSet {
  return Object.assign([], { clearSession() {} }) as unknown as ComputerUseToolSet;
}

function nativeTool(): MakaTool {
  return {
    name: 'browser_snapshot',
    description: 'Capture the current page.',
    parameters: z.object({}),
    impl: async () => 'snapshot',
  };
}

function connectionHarness(
  label: string,
  options: {
    revisionAbandon?: 'abandoned' | 'retained';
    subscriptionSnapshot?: SessionContinuitySnapshot;
    runtimeResourcePty?: ReturnType<typeof ptySnapshot>;
  } = {},
) {
  let resolveClosed: (() => void) | undefined;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  let resolveTurnStarted: (() => void) | undefined;
  const turnStarted = new Promise<void>((resolve) => {
    resolveTurnStarted = resolve;
  });
  const closeSubscriptions = new Set<() => void>();
  let provider: ClientCapabilityProvider | undefined;
  let capabilityRegistrations = 0;
  let capabilityUnregistrations = 0;
  let closeCalls = 0;
  let startTurnCalls = 0;
  let runtimeResourceControllerAcquires = 0;
  let activeSubscriptionFrames: AsyncFrameQueue | undefined;
  const connection = {
    hostEpoch: `host-${label}`,
    connectionId: `connection-${label}`,
    selectedProtocol: 0,
    closed,
    request: async <K extends OperationKey>(operation: K, input: OperationInput<K>) => {
      if (
        operation === 'session.catalog.query' &&
        (input as { kind?: unknown }).kind === 'list_start'
      ) {
        return {
          kind: 'page',
          revision: catalogRevision(label),
          sessions: [session(`session-${label}`)],
          nextCursor: null,
        };
      }
      if (operation === 'session.create') {
        return session((input as { sessionId: string }).sessionId);
      }
      if (operation === 'external-session.source.query') {
        return { adapterIds: ['codex'] };
      }
      if (
        operation === 'session.catalog.query' &&
        (input as { kind?: unknown }).kind === 'get'
      ) {
        const sessionId = (input as { sessionId: string }).sessionId;
        return {
          kind: 'session',
          session:
            options.revisionAbandon === undefined
              ? session(sessionId)
              : {
                  ...session(sessionId),
                  revisionRootSessionId: 'source-revision-root',
                  revisionParentSessionId: 'source-revision-root',
                  revisionOfTurnId: 'source-turn',
                  revisionIndex: 2,
                  revisionState: 'preparing',
                },
        };
      }
      if (operation === 'session.revision.abandon' && options.revisionAbandon) {
        return {
          kind: options.revisionAbandon,
          sessionId: (input as { targetSessionId: string }).targetSessionId,
        };
      }
      if (operation === 'runtime.resource.query') {
        return {
          kind: 'page',
          sessionId: (input as { sessionId: string }).sessionId,
          revision: catalogRevision(`${label}-resource`),
          resources: [],
          nextCursor: null,
        };
      }
      if (
        operation === 'runtime.resource.controller.acquire' &&
        options.runtimeResourcePty
      ) {
        runtimeResourceControllerAcquires += 1;
        return {
          controllerId: (input as { controllerId: string }).controllerId,
          nextSequence: options.runtimeResourcePty.sequence + 1,
          pty: options.runtimeResourcePty,
        };
      }
      if (operation === 'runtime.resource.controller.release') {
        return {
          controllerId: (input as { controllerId: string }).controllerId,
          released: true,
        };
      }
      if (operation === 'session.execution_boundary.query') {
        return { kind: 'managed', access: 'read_only', revision: 1 };
      }
      if (operation === 'session.lifecycle.set') {
        return session((input as { sessionId: string }).sessionId);
      }
      if (operation === 'turn.start') {
        startTurnCalls += 1;
        resolveTurnStarted?.();
        return {};
      }
      throw new Error(`Unexpected operation: ${operation}`);
    },
    openSessionSubscription: async ({ sessionId }: { sessionId: string }) => {
      const subscriptionFrames = new AsyncFrameQueue();
      activeSubscriptionFrames = subscriptionFrames;
      const closeSubscription = () => subscriptionFrames.end();
      closeSubscriptions.add(closeSubscription);
      return {
        hostEpoch: `host-${label}`,
        subscriptionId: `subscription-${label}`,
        snapshot: options.subscriptionSnapshot ?? {
          projectionRevision: 1,
          session: { sessionId },
        },
        loadTranscript: async () => [],
        [Symbol.asyncIterator]: () => subscriptionFrames[Symbol.asyncIterator](),
        close: async () => closeSubscription(),
      };
    },
    replaceClientCapabilities: async (next: ClientCapabilityProvider) => {
      provider = next;
      capabilityRegistrations += 1;
      return { registrationId: `registration-${label}`, revision: 1 };
    },
    unregisterClientCapabilities: async () => {
      capabilityUnregistrations += 1;
      return { registrationId: `registration-${label}`, revision: 2 };
    },
    close: async () => {
      closeCalls += 1;
      for (const closeSubscription of closeSubscriptions) closeSubscription();
      await provider?.close?.();
      resolveClosed?.();
    },
  } as unknown as RuntimeHostConnection;
  return {
    connection,
    turnStarted,
    invokeCapability: async (frame: ClientCapabilityCallFrame) => {
      assert.ok(provider?.call);
      return provider.call(frame, {
        signal: new AbortController().signal,
        accept: async () => undefined,
      });
    },
    disconnect: () => resolveClosed?.(),
    pushSubscriptionFrame: (frame: SubscriptionFrame) => {
      assert.ok(activeSubscriptionFrames);
      activeSubscriptionFrames.push(frame);
    },
    get capabilityRegistrations() {
      return capabilityRegistrations;
    },
    get capabilityUnregistrations() {
      return capabilityUnregistrations;
    },
    get closeCalls() {
      return closeCalls;
    },
    get startTurnCalls() {
      return startTurnCalls;
    },
    get runtimeResourceControllerAcquires() {
      return runtimeResourceControllerAcquires;
    },
  };
}

function continuitySnapshot(
  overrides: Partial<SessionContinuitySnapshot> = {},
): SessionContinuitySnapshot {
  return {
    schemaVersion: 3,
    session: {
      sessionId: 'session-1',
      metadataRevision: 1,
      status: 'running',
      createdAt: 1,
      lastUsedAt: 1,
      isArchived: false,
    },
    projectionRevision: 1,
    rootTurn: {
      sessionId: 'session-1',
      turnId: 'turn-1',
      runId: 'run-1',
      status: 'running',
    },
    goal: null,
    queue: {
      hostEpoch: 'host-1',
      queueRevision: 0,
      steering: [],
      followup: [],
    },
    interactions: { pending: [] },
    ...overrides,
  };
}

function pendingQuestion() {
  return {
    schemaVersion: 1 as const,
    interactionId: 'interaction-1',
    sessionId: 'session-1',
    turnId: 'turn-1',
    runId: 'run-1',
    revision: 1 as const,
    status: 'pending' as const,
    outcome: null,
    request: {
      kind: 'question' as const,
      toolUseId: 'tool-interaction-1',
      questions: [
        {
          question: 'Proceed?',
          options: [{ label: 'Yes', description: 'Continue.' }],
        },
      ],
    },
  };
}

function ptySnapshot(ref: string, buffer: string) {
  return {
    sessionId: 'session-1',
    ref,
    sequence: 4,
    buffer,
    size: { cols: 80, rows: 24 },
  };
}

class AsyncFrameQueue implements AsyncIterable<SubscriptionFrame> {
  readonly #frames: SubscriptionFrame[] = [];
  readonly #waiters: Array<
    (result: IteratorResult<SubscriptionFrame>) => void
  > = [];
  #ended = false;

  push(frame: SubscriptionFrame): void {
    const waiter = this.#waiters.shift();
    if (waiter) waiter({ value: frame, done: false });
    else this.#frames.push(frame);
  }

  end(): void {
    this.#ended = true;
    for (const waiter of this.#waiters.splice(0)) {
      waiter({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<SubscriptionFrame> {
    return {
      next: () => {
        const frame = this.#frames.shift();
        if (frame) return Promise.resolve({ value: frame, done: false });
        if (this.#ended) {
          return Promise.resolve({ value: undefined, done: true });
        }
        return new Promise((resolve) => this.#waiters.push(resolve));
      },
    };
  }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail('Timed out waiting for candidate state');
}

function capabilityFrame(sessionId: string): ClientCapabilityCallFrame {
  return {
    kind: 'client.capability.call',
    registrationId: 'registration-native-lifecycle',
    invocationId: `invocation-${sessionId}`,
    offerId: 'desktop_browser',
    serverId: 'desktop_browser',
    toolName: 'browser_snapshot',
    sessionId,
    turnId: `turn-${sessionId}`,
    cwd: '/workspace',
    toolCallId: `tool-${sessionId}`,
    arguments: {},
  };
}

function catalogRevision(seed: string): `sha256:${string}` {
  return `sha256:${seed.padEnd(64, seed).slice(0, 64)}`;
}

function session(id: string): SessionCatalogProjection {
  return {
    id,
    revision: 1,
    cwd: '/workspace',
    createdAt: 1,
    lastUsedAt: 1,
    name: id,
    isFlagged: false,
    isArchived: false,
    labels: [],
    labelsTruncated: false,
    hasUnread: false,
    status: 'active',
    backend: 'ai-sdk',
    llmConnectionSlug: 'test-connection',
    connectionLocked: true,
    model: 'test-model',
    permissionMode: 'ask',
    collaborationMode: 'agent',
    orchestrationMode: 'default',
  };
}
