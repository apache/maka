import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { SessionHeader } from '@maka/core/session';
import type { RuntimeReadModelSessionView } from '@maka/runtime/runtime-read-model';
import { openInteractiveArtifactStoreForWrite } from '@maka/storage/artifact-stores';
import { resolveStorageRoot, tryAcquireInteractiveRootOwner } from '@maka/storage/root-authority';
import type { ConnectionContext } from '../server/operation-dispatcher.js';
import { SessionAdmissionGate } from '../server/session-admission-gate.js';
import { HostSessionEffectCoordinator } from '../server/session-effect-coordinator.js';
import type { HostSessionEffectModel } from '../server/execution-model-authority.js';

const connectionContext: ConnectionContext = {
  hostEpoch: 'host-epoch-1',
  connectionId: 'connection-1',
  surface: 'tui',
  principal: 'local_os_user',
  acquireResidency: () => ({ release: () => undefined }),
};

test('Session recap publishes one protected result and exact retries never repeat provider work', async () => {
  await withHarness(async ({ store, coordinator, modelCalls }) => {
    const input = { sessionId: 'session-1', effectId: 'effect-1', reason: 'manual' as const };
    const generated = {
      ok: true as const,
      result: {
        kind: 'generated' as const,
        effectId: 'effect-1',
        reason: 'manual' as const,
        text: 'We shipped the Host-owned recap.',
        raw: 'Recap: "We shipped the Host-owned recap."',
      },
    };

    assert.deepEqual(
      await coordinator.handlers['session.recap.generate'](input, connectionContext),
      generated,
    );
    assert.deepEqual(
      await coordinator.handlers['session.recap.generate'](input, {
        ...connectionContext,
        connectionId: 'connection-2',
      }),
      generated,
    );
    assert.equal(modelCalls.count, 1);

    const successor = createCoordinator(
      store,
      {
        generateTitle: async () => undefined,
        generateRecap: async () => assert.fail('a durable exact retry must not call the model'),
      },
      {
        readSessionHeader: async () =>
          ({ isArchived: true, status: 'archived' }) as unknown as SessionHeader,
      },
    );
    assert.deepEqual(
      await successor.handlers['session.recap.generate'](input, connectionContext),
      generated,
    );
    assert.equal(modelCalls.count, 1);
    assert.deepEqual(
      await successor.handlers['session.recap.generate'](
        { ...input, reason: 'idle' },
        connectionContext,
      ),
      {
        ok: false,
        error: {
          code: 'operation_conflict',
          message: 'Recap effect identity is already in use',
        },
      },
    );
    assert.deepEqual(
      await successor.handlers['session.recap.generate'](
        { sessionId: 'session-1', effectId: 'effect-new', reason: 'manual' },
        connectionContext,
      ),
      {
        ok: false,
        error: {
          code: 'session_archived',
          message: 'Archived Session cannot generate a recap',
        },
      },
    );

    const records = await store.listPage('session-1', { offset: 0, limit: 10 });
    assert.equal(records.records.length, 2);
    for (const record of records.records) {
      assert.equal(record.source, 'session_effect');
      assert.equal(
        (await store.deleteUserArtifactInSession('session-1', record.id)).kind,
        'protected',
      );
    }
    await successor.close();
  });
});

test('Session effect leaves Turn admission free and drain aborts accepted recap work', async () => {
  const started = gate();
  await withHarness(
    async ({ store, coordinator, admission }) => {
      const pending = coordinator.handlers['session.recap.generate'](
        { sessionId: 'session-1', effectId: 'effect-running', reason: 'idle' },
        connectionContext,
      );
      await started.promise;
      assert.equal(coordinator.hasLiveSessionState('session-1'), true);
      assert.equal(await admission.run('session-1', () => 'turn admitted'), 'turn admitted');
      const successor = createCoordinator(
        store,
        {
          generateTitle: async () => undefined,
          generateRecap: async () => assert.fail('an intent without a result must not be retried'),
        },
        {
          readSessionHeader: async () =>
            ({ isArchived: true, status: 'archived' }) as unknown as SessionHeader,
        },
      );
      assert.deepEqual(
        await successor.handlers['session.recap.generate'](
          { sessionId: 'session-1', effectId: 'effect-running', reason: 'idle' },
          { ...connectionContext, connectionId: 'successor-client' },
        ),
        {
          ok: false,
          error: {
            code: 'outcome_unknown',
            message: 'Recap provider outcome is unknown; use a new effect identity to retry',
          },
        },
      );
      await successor.close();
      coordinator.beginDrain();
      assert.deepEqual(
        await coordinator.handlers['session.recap.generate'](
          { sessionId: 'session-1', effectId: 'effect-rejected', reason: 'manual' },
          connectionContext,
        ),
        {
          ok: false,
          error: { code: 'host_draining', message: 'Runtime Host is draining' },
        },
      );
      let closed = false;
      const close = coordinator.close().then(() => {
        closed = true;
      });
      const result = await pending;
      assert.deepEqual(result, {
        ok: true,
        result: {
          kind: 'failed',
          effectId: 'effect-running',
          reason: 'idle',
          errorClass: 'aborted',
        },
      });
      await close;
      assert.equal(closed, true);
      assert.equal(coordinator.hasLiveSessionState('session-1'), false);
    },
    {
      generateTitle: async () => undefined,
      generateRecap: async ({ abortSignal }) => {
        started.release();
        await new Promise<void>((resolve) =>
          abortSignal.addEventListener('abort', () => resolve(), { once: true }),
        );
        return {
          ok: false,
          errorClass: 'aborted',
        };
      },
    },
  );
});

test('Automatic title generation fences retirement until the effect settles', async () => {
  const started = gate();
  await withHarness(
    async ({ coordinator }) => {
      const pending = coordinator.generateTitle({
        sessionId: 'session-1',
        header: { id: 'session-1' } as SessionHeader,
        sourceText: 'A first user message',
      });
      await started.promise;
      assert.equal(coordinator.hasLiveSessionState('session-1'), true);
      assert.equal(coordinator.hasLiveSessionState('session-2'), false);

      coordinator.beginDrain();
      assert.equal(await pending, undefined);
      assert.equal(coordinator.hasLiveSessionState('session-1'), false);
    },
    {
      generateTitle: async ({ abortSignal }) => {
        started.release();
        await new Promise<void>((resolve) =>
          abortSignal.addEventListener('abort', () => resolve(), { once: true }),
        );
        return undefined;
      },
      generateRecap: async () => assert.fail('title generation must not call recap'),
    },
  );
});

test('Session recap keeps accounting failures non-terminal and unsafe to retry', async () => {
  let modelCalls = 0;
  let drains = 0;
  await withHarness(
    async ({ store, coordinator }) => {
      const input = {
        sessionId: 'session-1',
        effectId: 'effect-accounting',
        reason: 'manual' as const,
      };
      const unknown = {
        ok: false as const,
        error: {
          code: 'outcome_unknown' as const,
          message: 'Recap accounting outcome is unknown',
        },
      };
      assert.deepEqual(
        await coordinator.handlers['session.recap.generate'](input, connectionContext),
        unknown,
      );
      assert.deepEqual(
        await coordinator.handlers['session.recap.generate'](input, connectionContext),
        {
          ok: false,
          error: {
            code: 'outcome_unknown',
            message: 'Recap provider outcome is unknown; use a new effect identity to retry',
          },
        },
      );
      assert.equal(modelCalls, 1);
      assert.equal(drains, 1);
      assert.equal((await store.listPage('session-1', { offset: 0, limit: 10 })).records.length, 1);
    },
    {
      generateTitle: async () => undefined,
      generateRecap: async () => {
        modelCalls += 1;
        return { ok: false, errorClass: 'persistence' };
      },
    },
    { requestDrain: () => (drains += 1) },
  );
});

async function withHarness(
  run: (input: {
    store: Awaited<ReturnType<typeof openInteractiveArtifactStoreForWrite>>;
    coordinator: HostSessionEffectCoordinator;
    modelCalls: { count: number };
    admission: SessionAdmissionGate;
  }) => Promise<void>,
  overrideModel?: HostSessionEffectModel,
  options?: CoordinatorOptions,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'maka-session-effect-'));
  const capability = await resolveStorageRoot({ path: root, kind: 'interactive' });
  const owner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(owner);
  try {
    const store = await openInteractiveArtifactStoreForWrite(owner.lease);
    await store.recover();
    const modelCalls = { count: 0 };
    const model: HostSessionEffectModel =
      overrideModel ??
      ({
        generateTitle: async () => undefined,
        generateRecap: async () => {
          modelCalls.count += 1;
          return {
            ok: true,
            modelId: 'openrouter/free',
            messages: [{ role: 'user', content: 'history' }],
            raw: 'Recap: "We shipped the Host-owned recap."',
          };
        },
      } satisfies HostSessionEffectModel);
    const admission = options?.admission ?? new SessionAdmissionGate();
    const coordinator = createCoordinator(store, model, { ...options, admission });
    await run({ store, coordinator, modelCalls, admission });
    await coordinator.close();
  } finally {
    await owner.close();
    await rm(root, { recursive: true, force: true });
  }
}

function createCoordinator(
  artifacts: Awaited<ReturnType<typeof openInteractiveArtifactStoreForWrite>>,
  model: HostSessionEffectModel,
  options: CoordinatorOptions = {},
): HostSessionEffectCoordinator {
  return new HostSessionEffectCoordinator({
    model,
    readModel: {
      getSessionView: async () => ({ events: [] }) as unknown as RuntimeReadModelSessionView,
    },
    artifacts,
    sessions: { probeSessionRemoval: async () => ({ kind: 'present' }) },
    readSessionHeader:
      options.readSessionHeader ??
      (async () => ({ isArchived: false, status: 'active' }) as unknown as SessionHeader),
    sessionAdmission: options.admission ?? new SessionAdmissionGate(),
    acquireResidency: () => ({ release: () => undefined }),
    requestDrain:
      options.requestDrain ??
      (() => assert.fail('healthy Session effects must not request Host drain')),
  });
}

interface CoordinatorOptions {
  readonly admission?: SessionAdmissionGate;
  readonly readSessionHeader?: (sessionId: string) => Promise<SessionHeader>;
  readonly requestDrain?: () => void;
}

function gate(): { promise: Promise<void>; release(): void } {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
