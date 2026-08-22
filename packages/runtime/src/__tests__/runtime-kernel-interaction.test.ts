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

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { SessionEvent } from '@maka/core/events';

import type { SessionHeader, StoredMessage } from '@maka/core/session';
import type { SandboxBoundaryResponse } from '@maka/core/sandbox-boundary';
import type { AgentBackend, BackendSendInput, BackendStopMode } from '@maka/core/backend-types';

import {
  RuntimeInteractionFailStopError,
  RuntimeInteractionInvariantError,
  type RuntimeInteractionAuthority,
} from '../interaction-authority.js';
import {
  RuntimeKernel,
  type RuntimeKernelDeps,
  RuntimeOwnerCleanupError,
} from '../runtime-kernel.js';
import { BackendRegistry, type SessionStore } from '../session-manager.js';

describe('RuntimeKernel Interaction close cleanup', () => {
  test('reserve followed by begin failure settles a concurrent stop claim', async () => {
    const store = memoryStore();
    const updateHeader = store.updateHeader;
    const backends = new BackendRegistry();
    const backend = new BlockingBackend(SESSION_ID, {});
    backends.register('ai-sdk', () => backend);
    const startupFailure = new Error('mark running rejected after reservation');
    let stoppedFailure: Promise<unknown> | undefined;
    let kernel!: RuntimeKernel;
    store.updateHeader = async (sessionId, patch) => {
      if (patch.status === 'running') {
        stoppedFailure = rejectionOf(kernel.stopSession(SESSION_ID, { source: 'stop_button' }));
        throw startupFailure;
      }
      return await updateHeader(sessionId, patch);
    };
    let id = 0;
    kernel = new RuntimeKernel({
      store,
      backends,
      newId: () => `begin-failure-id-${++id}`,
      now: () => id,
    });
    const iterator = kernel
      .startTurn(SESSION_ID, { turnId: 'turn-begin-failure', text: 'start' })
      [Symbol.asyncIterator]();
    const startFailure = rejectionOf(iterator.next());

    await waitFor(() => stoppedFailure !== undefined);
    const ownershipFailure = await within(stoppedFailure!, 'concurrent stop ownership');
    assert.equal(containsFailure(ownershipFailure, startupFailure), true);
    assert.equal(backend.sendCalls, 0);
    assert.equal(
      containsFailure(await within(startFailure, 'failed Run start'), startupFailure),
      true,
    );
    await iterator.return?.(undefined).catch(() => undefined);
  });

  test('stop during owner bind waits for exact close and reports its failure once', async () => {
    const store = memoryStore();
    const backends = new BackendRegistry();
    const backend = new BlockingBackend(SESSION_ID, {});
    backends.register('ai-sdk', () => backend);
    const closeFailure = new Error('bind-race close rejected');
    const closeStarted = deferred<void>();
    const releaseClose = deferred<void>();
    let closeCalls = 0;
    let stopped: Promise<void> | undefined;
    let stoppedFailure: Promise<unknown> | undefined;
    let kernel!: RuntimeKernel;
    const interactionAuthority: RuntimeInteractionAuthority = {
      bindRun: (identity) => {
        stopped = kernel.stopSession(SESSION_ID, { source: 'stop_button' });
        stoppedFailure = rejectionOf(stopped);
        return {
          ...identity,
          acceptSandboxBoundaryRequest: async () => {},
          acceptUserQuestionRequest: async () => {},
          close: async () => {
            closeCalls += 1;
            closeStarted.resolve();
            await releaseClose.promise;
            throw closeFailure;
          },
          release: () => assert.fail('failed close must retain the owner'),
        };
      },
    };
    let id = 0;
    kernel = new RuntimeKernel({
      store,
      backends,
      interactionAuthority,
      newId: () => `bind-race-id-${++id}`,
      now: () => id,
    });
    const iterator = kernel
      .startTurn(SESSION_ID, { turnId: 'turn-bind-race', text: 'start' })
      [Symbol.asyncIterator]();
    const firstFailure = rejectionOf(iterator.next());

    await waitFor(() => stopped !== undefined && stoppedFailure !== undefined);
    await closeStarted.promise;
    releaseClose.resolve();
    const failure = await stoppedFailure!;
    assert.equal(containsFailure(failure, closeFailure), true);
    assert.equal(closeCalls, 1);
    assert.equal(backend.stopCalls.length, 1);

    await firstFailure;
    await iterator.return?.(undefined).catch(() => undefined);
    assert.equal(closeCalls, 1);
  });

  test('explicit stop starts backend cleanup before deferred close settles and reports both failures', async () => {
    const stopFailure = new Error('backend stop rejected');
    const fixture = runtimeFixture({ deferredClose: true, stopFailure });
    const iterator = fixture.kernel
      .startTurn(SESSION_ID, { turnId: 'turn-explicit-stop', text: 'start' })
      [Symbol.asyncIterator]();

    assert.equal((await iterator.next()).value?.type, 'text_delta');
    const stopped = fixture.kernel.stopSession(SESSION_ID, { source: 'stop_button' });

    await fixture.closeStarted;
    assert.equal(fixture.backend.stopCalls.length, 1);
    fixture.releaseClose();

    const failure = await rejectionOf(stopped);
    assert.ok(failure instanceof RuntimeOwnerCleanupError);
    assert.equal(containsFailure(failure, fixture.closeFailure), true);
    assert.equal(containsFailure(failure, stopFailure), true);
    await iterator.return?.(undefined).catch(() => undefined);
  });

  test('abandoned consumer starts backend cleanup before deferred close settles', async () => {
    const fixture = runtimeFixture({ deferredClose: true });
    const iterator = fixture.kernel
      .startTurn(SESSION_ID, { turnId: 'turn-abandoned', text: 'start' })
      [Symbol.asyncIterator]();

    assert.equal((await iterator.next()).value?.type, 'text_delta');
    const abandoned = iterator.return!(undefined);

    await fixture.closeStarted;
    assert.equal(fixture.backend.stopCalls.length, 1);
    fixture.releaseClose();

    const failure = await rejectionOf(abandoned);
    assertCanonicalCloseFailure(failure, fixture.closeFailure);
  });

  test('multiple owner cleanup failures retain one fail-stop marker', async () => {
    const messageReleaseFailure = new Error('message owner release rejected');
    const fixture = runtimeFixture({ messageReleaseFailure });
    const iterator = fixture.kernel
      .startTurn(SESSION_ID, { turnId: 'turn-multiple-owner-failures', text: 'start' })
      [Symbol.asyncIterator]();
    const draining = drainIterator(iterator);
    await waitFor(() => fixture.backend.sendCalls === 1);

    fixture.backend.releaseBlockedSend();
    const failure = await rejectionOf(draining);

    assert.ok(failure instanceof RuntimeOwnerCleanupError);
    assert.equal(containsFailure(failure, fixture.closeFailure), true);
    assert.equal(containsFailure(failure, messageReleaseFailure), true);
  });

  test('explicit stop and iterator cleanup share one pending backend stop attempt', async () => {
    const stopFailure = new Error('shared backend stop rejected');
    const fixture = runtimeFixture({
      closeSucceeds: true,
      deferredStop: true,
      stopFailure,
    });
    const iterator = fixture.kernel
      .startTurn(SESSION_ID, { turnId: 'turn-concurrent-stop', text: 'start' })
      [Symbol.asyncIterator]();

    assert.equal((await iterator.next()).value?.type, 'text_delta');
    const stopped = fixture.kernel.stopSession(SESSION_ID, {
      source: 'stop_button',
      mode: 'after_step',
    });
    await fixture.backend.stopStarted;

    const abandoned = iterator.return!(undefined);
    await Promise.resolve();
    assert.deepEqual(fixture.backend.stopCalls, [{ reason: 'user_stop', mode: 'after_step' }]);

    fixture.backend.releaseStop();
    const [explicitFailure, cleanupFailure] = await Promise.all([
      rejectionOf(stopped),
      rejectionOf(abandoned),
    ]);

    assert.equal(explicitFailure, stopFailure);
    assert.equal(cleanupFailure, stopFailure);
    assert.equal(fixture.backend.stopCalls.length, 1);
  });

  test('public stop rejection with a blocked send actively disposes the backend', async () => {
    const stopFailure = new Error('stop rejected without releasing send');
    const fixture = runtimeFixture({
      closeSucceeds: true,
      stopFailure,
      releaseSendOnStop: false,
      releaseSendOnDispose: false,
    });
    const iterator = fixture.kernel
      .startTurn(SESSION_ID, { turnId: 'turn-blocked-send', text: 'start' })
      [Symbol.asyncIterator]();

    assert.equal((await iterator.next()).value?.type, 'text_delta');
    const failure = await rejectionOf(
      fixture.kernel.stopSession(SESSION_ID, { source: 'stop_button' }),
    );

    assert.equal(containsFailure(failure, stopFailure), true);
    assert.equal(fixture.backend.disposeCalls, 1);
    const retryFailure = await rejectionOf(
      fixture.kernel.stopSession(SESSION_ID, { source: 'stop_button' }),
    );
    assert.equal(containsFailure(retryFailure, stopFailure), true);
    assert.equal(fixture.backend.stopCalls.length, 1);
    const messages = await fixture.store.readMessages(SESSION_ID);
    assert.equal(
      messages.filter(
        (message) =>
          message.type === 'turn_state' &&
          message.turnId === 'turn-blocked-send' &&
          message.status === 'aborted',
      ).length,
      1,
    );
    assert.equal(
      messages.filter((message) => message.type === 'system_note' && message.kind === 'abort')
        .length,
      1,
    );

    const blockedActivation = fixture.kernel
      .startTurn(SESSION_ID, { turnId: 'turn-before-runner-settled', text: 'must not send' })
      [Symbol.asyncIterator]();
    await assert.rejects(blockedActivation.next(), /quarantined/);
    assert.equal(fixture.backend.sendCalls, 1);

    fixture.backend.releaseBlockedSend();
    await drainIterator(iterator);
  });

  test('a generation stopped after Run reservation cannot send on the stale backend', async () => {
    const store = memoryStore();
    const backends = new BackendRegistry();
    const backend = new BlockingBackend(SESSION_ID, {
      stopFailure: new Error('reserved generation stop failed'),
      releaseSendOnStop: false,
      releaseSendOnDispose: false,
    });
    backends.register('ai-sdk', () => backend);
    const secondReserved = deferred<void>();
    const releaseSecond = deferred<void>();
    let reservations = 0;
    let id = 0;
    const kernel = new RuntimeKernel({
      store,
      backends,
      newId: () => `reservation-id-${++id}`,
      now: () => id,
      runBackendActivation: async (operation) => {
        const result = await operation();
        reservations += 1;
        if (reservations === 2) {
          secondReserved.resolve();
          await releaseSecond.promise;
        }
        return result;
      },
    });

    const first = kernel
      .startTurn(SESSION_ID, { turnId: 'turn-reservation-1', text: 'first' })
      [Symbol.asyncIterator]();
    assert.equal((await first.next()).value?.type, 'text_delta');
    const second = kernel
      .startTurn(SESSION_ID, { turnId: 'turn-reservation-2', text: 'second' })
      [Symbol.asyncIterator]();
    const secondEvent = second.next();
    await secondReserved.promise;

    await assert.rejects(
      kernel.stopSession(SESSION_ID, { source: 'stop_button' }),
      /reserved generation stop failed/,
    );
    assert.equal(backend.disposeCalls, 1);
    assert.equal(backend.sendCalls, 1);

    releaseSecond.resolve();
    assert.equal((await secondEvent).done, true);
    assert.equal(backend.sendCalls, 1);

    backend.releaseBlockedSend();
    await drainIterator(first).catch(() => undefined);
  });

  test('a failed stop operation is not reused by the next backend Run generation', async () => {
    const store = memoryStore();
    const backends = new BackendRegistry();
    const built: BlockingBackend[] = [];
    backends.register('ai-sdk', () => {
      const backend = new BlockingBackend(
        SESSION_ID,
        built.length === 0
          ? {
              stopFailure: new Error('first generation stop failed'),
              releaseSendOnStop: false,
            }
          : {},
      );
      built.push(backend);
      return backend;
    });
    let id = 0;
    const kernel = new RuntimeKernel({
      store,
      backends,
      newId: () => `generation-id-${++id}`,
      now: () => id,
    });

    const first = kernel
      .startTurn(SESSION_ID, { turnId: 'turn-generation-1', text: 'first' })
      [Symbol.asyncIterator]();
    assert.equal((await first.next()).value?.type, 'text_delta');
    await assert.rejects(
      kernel.stopSession(SESSION_ID, { source: 'stop_button', mode: 'after_step' }),
      /first generation stop failed/,
    );
    await drainIterator(first);
    assert.equal(built[0]?.disposeCalls, 1);
    assert.deepEqual(built[0]?.stopCalls, [{ reason: 'user_stop', mode: 'after_step' }]);
    const firstMessages = await store.readMessages(SESSION_ID);
    assert.equal(
      firstMessages.filter(
        (message) =>
          message.type === 'turn_state' &&
          message.turnId === 'turn-generation-1' &&
          message.status === 'aborted',
      ).length,
      1,
    );
    assert.equal(
      firstMessages.filter((message) => message.type === 'system_note' && message.kind === 'abort')
        .length,
      1,
    );

    const second = kernel
      .startTurn(SESSION_ID, { turnId: 'turn-generation-2', text: 'second' })
      [Symbol.asyncIterator]();
    assert.equal((await second.next()).value?.type, 'text_delta');
    await kernel.stopSession(SESSION_ID, { source: 'stop_button', mode: 'immediate' });
    await second.return!(undefined).catch(() => undefined);

    assert.equal(built.length, 2);
    assert.deepEqual(built[1]?.stopCalls[0], { reason: 'user_stop', mode: 'immediate' });
    assert.equal(
      built[1]?.stopCalls.some((call) => call.mode === 'after_step'),
      false,
    );
  });

  test('disposal failure permanently quarantines the Session from backend activation', async () => {
    const store = memoryStore();
    const backends = new BackendRegistry();
    const built: BlockingBackend[] = [];
    const stopFailure = new Error('backend stop failed');
    const disposeFailure = new Error('backend disposal failed');
    backends.register('ai-sdk', () => {
      const backend = new BlockingBackend(SESSION_ID, {
        stopFailure,
        disposeFailure,
        releaseSendOnDispose: false,
        releaseSendOnStop: false,
      });
      built.push(backend);
      return backend;
    });
    let id = 0;
    const kernel = new RuntimeKernel({
      store,
      backends,
      newId: () => `quarantine-id-${++id}`,
      now: () => id,
    });

    const first = kernel
      .startTurn(SESSION_ID, { turnId: 'turn-quarantine-1', text: 'first' })
      [Symbol.asyncIterator]();
    assert.equal((await first.next()).value?.type, 'text_delta');
    const stopped = await rejectionOf(kernel.stopSession(SESSION_ID, { source: 'stop_button' }));
    assert.equal(containsFailure(stopped, stopFailure), true);
    assert.equal(containsFailure(stopped, disposeFailure), true);
    await assert.rejects(kernel.invalidateCachedBackends(), /backend disposal failed/);
    assert.equal(built[0]?.disposeCalls, 1);
    built[0]?.releaseBlockedSend();
    await drainIterator(first);
    assert.equal(built[0]?.disposeCalls, 1);

    for (const turnId of ['turn-quarantine-2', 'turn-quarantine-3']) {
      const blocked = kernel
        .startTurn(SESSION_ID, { turnId, text: 'must not build' })
        [Symbol.asyncIterator]();
      await assert.rejects(blocked.next(), /permanently quarantined/);
    }
    assert.equal(built.length, 1);
    assert.equal(built[0]?.disposeCalls, 1);
  });
});

const SESSION_ID = 'session-interaction-cleanup';

interface RuntimeFixtureOptions {
  closeSucceeds?: boolean;
  deferredClose?: boolean;
  deferredStop?: boolean;
  stopFailure?: Error;
  disposeFailure?: Error;
  releaseSendOnDispose?: boolean;
  releaseSendOnStop?: boolean;
  messageReleaseFailure?: Error;
  runBackendActivation?: RuntimeKernelDeps['runBackendActivation'];
}

function runtimeFixture(options: RuntimeFixtureOptions = {}): {
  kernel: RuntimeKernel;
  backend: BlockingBackend;
  store: SessionStore;
  closeFailure: Error;
  closeStarted: Promise<void>;
  releaseClose: () => void;
} {
  const store = memoryStore();
  const backends = new BackendRegistry();
  const backend = new BlockingBackend(SESSION_ID, options);
  backends.register('ai-sdk', () => backend);
  const closeFailure = new Error('durable close rejected');
  let markCloseStarted!: () => void;
  const closeStarted = new Promise<void>((resolve) => {
    markCloseStarted = resolve;
  });
  let releaseClose!: () => void;
  const closeReleased = new Promise<void>((resolve) => {
    releaseClose = resolve;
  });
  const interactionAuthority: RuntimeInteractionAuthority = {
    bindRun: (identity) => ({
      ...identity,
      acceptSandboxBoundaryRequest: async () => {},
      acceptUserQuestionRequest: async () => {},
      close: async () => {
        markCloseStarted();
        if (options.deferredClose) await closeReleased;
        if (!options.closeSucceeds) throw closeFailure;
      },
      release: () => {
        if (!options.closeSucceeds) {
          assert.fail('a Run with failed durable close must not release');
        }
      },
    }),
  };
  let id = 0;
  return {
    kernel: new RuntimeKernel({
      store,
      backends,
      interactionAuthority,
      ...(options.messageReleaseFailure
        ? {
            messageAuthority: {
              bindRun: (identity) => ({
                ...identity,
                pull: () => [],
                ack: () => {},
                nack: () => {},
                release: () => {
                  throw options.messageReleaseFailure;
                },
              }),
            },
          }
        : {}),
      newId: () => `id-${++id}`,
      now: () => id,
      ...(options.runBackendActivation
        ? { runBackendActivation: options.runBackendActivation }
        : {}),
    }),
    backend,
    store,
    closeFailure,
    closeStarted,
    releaseClose,
  };
}

class BlockingBackend implements AgentBackend {
  readonly kind = 'ai-sdk' as const;
  readonly stopCalls: Array<{
    reason: 'user_stop' | 'redirect';
    mode: BackendStopMode | undefined;
  }> = [];
  readonly stopStarted: Promise<void>;
  disposeCalls = 0;
  sendCalls = 0;
  private markStopStarted!: () => void;
  private readonly stopReleased: Promise<void>;
  private releaseStopGate!: () => void;
  private releaseSend: (() => void) | undefined;
  private readonly sendReleased = new Promise<void>((resolve) => {
    this.releaseSend = resolve;
  });

  constructor(
    readonly sessionId: string,
    private readonly options: {
      deferredStop?: boolean;
      stopFailure?: Error;
      disposeFailure?: Error;
      releaseSendOnDispose?: boolean;
      releaseSendOnStop?: boolean;
    },
  ) {
    this.stopStarted = new Promise<void>((resolve) => {
      this.markStopStarted = resolve;
    });
    this.stopReleased = new Promise<void>((resolve) => {
      this.releaseStopGate = resolve;
    });
  }

  async *send(input: BackendSendInput): AsyncIterable<SessionEvent> {
    this.sendCalls += 1;
    yield {
      type: 'text_delta',
      id: `${input.turnId}-delta`,
      turnId: input.turnId,
      ts: 1,
      messageId: `${input.turnId}-message`,
      text: 'started',
    };
    await this.sendReleased;
    yield {
      type: 'complete',
      id: `${input.turnId}-complete`,
      turnId: input.turnId,
      ts: 2,
      stopReason: 'user_stop',
    };
  }

  async stop(reason: 'user_stop' | 'redirect', mode?: BackendStopMode): Promise<void> {
    this.stopCalls.push({ reason, mode });
    this.markStopStarted();
    if (this.options.deferredStop) await this.stopReleased;
    if (this.options.releaseSendOnStop !== false) this.releaseSend?.();
    if (this.options.stopFailure) throw this.options.stopFailure;
  }

  releaseStop(): void {
    this.releaseStopGate();
  }

  releaseBlockedSend(): void {
    this.releaseSend?.();
  }

  async respondToSandboxBoundary(_decision: SandboxBoundaryResponse): Promise<void> {}

  async dispose(): Promise<void> {
    this.disposeCalls += 1;
    if (this.options.releaseSendOnDispose !== false) this.releaseSend?.();
    if (this.options.disposeFailure) throw this.options.disposeFailure;
  }
}

async function drainIterator(iterator: AsyncIterator<SessionEvent>): Promise<void> {
  while (!(await iterator.next()).done) {
    // Drain the active Runtime Run without abandoning its consumer.
  }
}

function memoryStore(): SessionStore {
  let header: SessionHeader = {
    id: SESSION_ID,
    workspaceRoot: '/tmp/maka-runtime-kernel-interaction',
    cwd: '/tmp/maka-runtime-kernel-interaction',
    createdAt: 1,
    lastUsedAt: 1,
    name: 'Interaction cleanup',
    titleIsManual: true,
    isFlagged: false,
    labels: [],
    isArchived: false,
    status: 'active',
    statusUpdatedAt: 1,
    hasUnread: false,
    backend: 'ai-sdk',
    llmConnectionSlug: 'test',
    connectionLocked: true,
    model: 'test',
    permissionMode: 'bypass',
    schemaVersion: 1,
  };
  let messages: StoredMessage[] = [];
  return {
    create: async () => header,
    createSubagent: async () => ({ header, created: false }),
    setExecutionBoundaryKind: async () => {
      throw new Error('not implemented');
    },
    readExecutionBoundary: async () => {
      throw new Error('not implemented');
    },
    list: async () => [],
    readHeader: async () => header,
    readMessages: async () => [...messages],
    listTurns: async () => [],
    appendMessage: async (_sessionId, message) => {
      messages.push(message);
    },
    appendMessages: async (_sessionId, next) => {
      messages.push(...next);
    },
    updateHeader: async (_sessionId, patch) => {
      header = { ...header, ...patch };
      return header;
    },
    setFlagged: async () => {},
    rename: async () => {},
    remove: async () => {},
  };
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  assert.fail('expected rejection');
}

function assertCanonicalCloseFailure(failure: unknown, closeFailure: Error): void {
  assert.ok(failure instanceof RuntimeInteractionFailStopError);
  assert.equal(failure.authorityFailure, closeFailure);
}

function containsFailure(failure: unknown, expected: unknown): boolean {
  if (failure === expected) return true;
  if (failure instanceof RuntimeOwnerCleanupError && containsFailure(failure.cause, expected)) {
    return true;
  }
  if (
    failure instanceof RuntimeInteractionFailStopError &&
    containsFailure(failure.authorityFailure, expected)
  ) {
    return true;
  }
  return (
    failure instanceof AggregateError &&
    failure.errors.some((nested) => containsFailure(nested, expected))
  );
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail('condition was not met');
}

async function within<T>(promise: Promise<T>, operation: string): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(`${operation} timed out`)), 1_000);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
