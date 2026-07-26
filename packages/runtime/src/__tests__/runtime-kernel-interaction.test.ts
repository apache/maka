import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { SessionEvent, SessionHeader, StoredMessage } from '@maka/core';
import type {
  AgentBackend,
  BackendSendInput,
  BackendStopMode,
  PermissionDecision,
} from '@maka/core/backend-types';

import {
  RuntimeInteractionFailStopError,
  type RuntimeInteractionAuthority,
} from '../interaction-authority.js';
import { RuntimeKernel } from '../runtime-kernel.js';
import { BackendRegistry, type SessionStore } from '../session-manager.js';

describe('RuntimeKernel Interaction close cleanup', () => {
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
});

const SESSION_ID = 'session-interaction-cleanup';

interface RuntimeFixtureOptions {
  closeSucceeds?: boolean;
  deferredClose?: boolean;
  deferredStop?: boolean;
  stopFailure?: Error;
}

function runtimeFixture(options: RuntimeFixtureOptions = {}): {
  kernel: RuntimeKernel;
  backend: BlockingBackend;
  closeFailure: Error;
  closeStarted: Promise<void>;
  releaseClose: () => void;
} {
  const store = memoryStore();
  const backends = new BackendRegistry();
  const backend = new BlockingBackend(SESSION_ID, options);
  backends.register('fake', () => backend);
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
      acceptPermissionRequest: async () => ({ state: 'pending' }),
      commitPermissionAnswer: async ({ answer }) => ({
        kind: 'permission_answer',
        answer,
      }),
      commitPermissionTimeout: async () => ({ kind: 'closure', reason: 'timed_out' }),
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
      newId: () => `id-${++id}`,
      now: () => id,
    }),
    backend,
    closeFailure,
    closeStarted,
    releaseClose,
  };
}

class BlockingBackend implements AgentBackend {
  readonly kind = 'fake' as const;
  readonly stopCalls: Array<{
    reason: 'user_stop' | 'redirect';
    mode: BackendStopMode | undefined;
  }> = [];
  readonly stopStarted: Promise<void>;
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
    this.releaseSend?.();
    if (this.options.stopFailure) throw this.options.stopFailure;
  }

  releaseStop(): void {
    this.releaseStopGate();
  }

  async respondToPermission(_decision: PermissionDecision): Promise<void> {}

  async dispose(): Promise<void> {}
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
    backend: 'fake',
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
    markSessionReadThrough: async () => header,
    archive: async () => {},
    unarchive: async () => {},
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
