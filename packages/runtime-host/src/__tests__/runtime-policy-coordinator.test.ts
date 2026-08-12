import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mock, test } from 'node:test';
import type {
  ConnectionCatalogEntryDraft,
  ConnectionCatalogSnapshot,
  CredentialLocator,
} from '@maka/core/runtime-policy';
import { REQUEST_BODY_OVERLAY_MAX_BYTES } from '@maka/core/runtime-policy';
import { FAKE_ASK_USER_QUESTION_PROMPT, FakeBackend } from '@maka/runtime/fake-backend';
import { type MakaToolContext } from '@maka/runtime/tool-runtime';
import { openInteractiveExecutionStoresForWrite } from '@maka/storage/execution-stores';
import { openInteractiveRuntimePolicyStoresForWrite } from '@maka/storage/runtime-policy-stores';
import { resolveStorageRoot, tryAcquireInteractiveRootOwner } from '@maka/storage/root-authority';
import {
  CONNECTION_CATALOG_PAGE_MAX_BYTES,
  CONNECTION_CATALOG_PAGE_MAX_ITEMS,
  RUNTIME_POLICY_OPERATION_SPECS,
  type ConnectionCatalogPageItem,
} from '../protocol/index.js';
import { createExecutionRuntimeHostComposition } from '../server/execution-composition.js';
import type { ConnectionContext } from '../server/operation-dispatcher.js';
import { RuntimePolicyActivationGate } from '../server/runtime-policy-activation-gate.js';
import { HostRuntimePolicyCoordinator } from '../server/runtime-policy-coordinator.js';

const context: ConnectionContext = {
  hostEpoch: 'runtime-policy-test-epoch',
  connectionId: 'runtime-policy-test-connection',
  surface: 'desktop',
  principal: 'local_os_user',
  acquireResidency: () => ({ release: () => undefined }),
};

test('model settings tool confirms and atomically updates canonical Runtime Policy', async () => {
  await withCoordinator(async ({ coordinator, stores }) => {
    const tool = coordinator.modelTools.find(({ name }) => name === 'MakaSettingsUpdate');
    assert.ok(tool);
    if (!tool) return;
    const questions: string[] = [];
    const toolContext: MakaToolContext = {
      sessionId: 'session-1',
      turnId: 'turn-1',
      cwd: '/workspace',
      toolCallId: 'call-1',
      abortSignal: new AbortController().signal,
      emitOutput() {},
      askUserQuestion: async (input) => {
        questions.push(...input.map(({ question }) => question));
        return {
          answers: input.map(({ question }) => ({ question, answer: 'Apply changes' })),
        };
      },
    };

    const result = await tool.impl(
      {
        personalization: { assistantTone: 'Be direct.' },
        memory: { agentReadEnabled: true },
        webSearch: { enabled: true },
      },
      toolContext,
    );

    assert.equal((result as { applied?: boolean }).applied, true);
    assert.equal(questions.length, 1);
    const snapshot = await stores.runtimePolicy.getSnapshot();
    assert.equal(snapshot.revision, 1);
    assert.equal(snapshot.policy.personalization.assistantTone, 'Be direct.');
    assert.equal(snapshot.policy.memory.agentReadEnabled, true);
    assert.equal(snapshot.policy.webSearch.enabled, true);
  });
});

test('production composition shares one gate across mutation and backend activation', async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-runtime-policy-composition-'));
  const root = join(base, 'interactive');
  const capability = await resolveStorageRoot({ path: root, kind: 'interactive' });
  const owner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(owner);
  if (!owner) return;

  const mutationGates: RuntimePolicyActivationGate[] = [];
  const backendActivationGates: RuntimePolicyActivationGate[] = [];
  const originalRunMutation = RuntimePolicyActivationGate.prototype.runMutation;
  const originalRunBackendActivation = RuntimePolicyActivationGate.prototype.runBackendActivation;
  const mutationSpy = mock.method(RuntimePolicyActivationGate.prototype, 'runMutation', function <
    T,
  >(this: RuntimePolicyActivationGate, operation: () => Promise<T> | T): Promise<T> {
    mutationGates.push(this);
    return Reflect.apply(originalRunMutation, this, [operation]) as Promise<T>;
  });
  const backendActivationSpy = mock.method(
    RuntimePolicyActivationGate.prototype,
    'runBackendActivation',
    function <T>(this: RuntimePolicyActivationGate, operation: () => Promise<T> | T): Promise<T> {
      backendActivationGates.push(this);
      return Reflect.apply(originalRunBackendActivation, this, [operation]) as Promise<T>;
    },
  );
  let composition: Awaited<ReturnType<typeof createExecutionRuntimeHostComposition>> | undefined;
  try {
    const setupStores = await openInteractiveExecutionStoresForWrite(owner.lease);
    const session = await setupStores.sessionStore.create({
      cwd: root,
      backend: 'fake',
      llmConnectionSlug: 'fake',
      model: 'fake-model',
      permissionMode: 'ask',
    });

    composition = await createExecutionRuntimeHostComposition({
      owner,
      hostEpoch: context.hostEpoch,
      acquireResidency: context.acquireResidency,
      retainUntilProcessExit: () => undefined,
      requestDrain: () => undefined,
    });
    await composition.recover();

    const initial = await composition.handlers['runtime.policy.query']({}, context);
    assert.equal(initial.ok, true);
    if (!initial.ok) return;
    const turnId = randomUUID();
    const [mutated, started] = await Promise.all([
      composition.handlers['runtime.policy.mutate'](
        {
          expectedRevision: initial.result.revision,
          operation: {
            kind: 'set_memory',
            value: { enabled: false, agentReadEnabled: false },
          },
        },
        context,
      ),
      composition.handlers['turn.start'](
        {
          sessionId: session.id,
          turnId,
          content: { text: FAKE_ASK_USER_QUESTION_PROMPT },
        },
        context,
      ),
    ]);

    assert.equal(mutated.ok, true);
    assert.equal(started.ok, true);
    assert.ok(mutationGates.length >= 2);
    assert.equal(backendActivationGates.length, 1);
    assert.ok(mutationGates.every((gate) => gate === backendActivationGates[0]));
    if (started.ok && started.result.kind === 'started') {
      await composition.handlers['turn.stop'](
        { sessionId: session.id, turnId, runId: started.result.turn.runId },
        context,
      );
    }
  } finally {
    mutationSpy.mock.restore();
    backendActivationSpy.mock.restore();
    try {
      await composition?.close();
    } finally {
      try {
        await owner.close();
      } finally {
        await rm(base, { recursive: true, force: true });
      }
    }
  }
});

test('production mutation releases the gate before active-turn backend disposal completes', async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-runtime-policy-active-turn-refresh-'));
  const root = join(base, 'interactive');
  const capability = await resolveStorageRoot({ path: root, kind: 'interactive' });
  const owner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(owner);
  if (!owner) return;

  const activationEntered = deferred<void>();
  const releaseActivation = deferred<void>();
  const originalRunBackendActivation = RuntimePolicyActivationGate.prototype.runBackendActivation;
  let heldActivation = false;
  const activationSpy = mock.method(
    RuntimePolicyActivationGate.prototype,
    'runBackendActivation',
    function <T>(this: RuntimePolicyActivationGate, operation: () => Promise<T> | T): Promise<T> {
      return Reflect.apply(originalRunBackendActivation, this, [
        async () => {
          const result = await operation();
          if (!heldActivation) {
            heldActivation = true;
            activationEntered.resolve();
            await releaseActivation.promise;
          }
          return result;
        },
      ]) as Promise<T>;
    },
  );
  let composition: Awaited<ReturnType<typeof createExecutionRuntimeHostComposition>> | undefined;
  try {
    const setupStores = await openInteractiveExecutionStoresForWrite(owner.lease);
    const session = await setupStores.sessionStore.create({
      cwd: root,
      backend: 'fake',
      llmConnectionSlug: 'fake',
      model: 'fake-model',
      permissionMode: 'ask',
    });
    composition = await createExecutionRuntimeHostComposition({
      owner,
      hostEpoch: context.hostEpoch,
      acquireResidency: context.acquireResidency,
      retainUntilProcessExit: () => undefined,
      requestDrain: () => undefined,
    });
    await composition.recover();

    const initial = await composition.handlers['runtime.policy.query']({}, context);
    assert.equal(initial.ok, true);
    if (!initial.ok) return;
    const turnId = randomUUID();
    const start = composition.handlers['turn.start'](
      {
        sessionId: session.id,
        turnId,
        content: { text: FAKE_ASK_USER_QUESTION_PROMPT },
      },
      context,
    );
    await activationEntered.promise;

    const mutation = composition.handlers['runtime.policy.mutate'](
      {
        expectedRevision: initial.result.revision,
        operation: {
          kind: 'set_memory',
          value: { enabled: false, agentReadEnabled: false },
        },
      },
      context,
    );
    releaseActivation.resolve();

    assert.deepEqual(await settlesWithin(mutation, 'policy mutation'), {
      ok: true,
      result: { kind: 'committed', revision: initial.result.revision + 1 },
    });
    const memory = await settlesWithin(
      composition.handlers['memory.query']({ kind: 'state' }, context),
      'policy-dependent read',
    );
    assert.equal(memory.ok, true);

    const started = await start;
    assert.equal(started.ok, true);
    if (started.ok && started.result.kind === 'started') {
      await composition.handlers['turn.stop'](
        { sessionId: session.id, turnId, runId: started.result.turn.runId },
        context,
      );
    }
  } finally {
    activationSpy.mock.restore();
    try {
      await composition?.close();
    } finally {
      try {
        await owner.close();
      } finally {
        await rm(base, { recursive: true, force: true });
      }
    }
  }
});

test('production policy mutation drains and poisons activation when cached backend disposal fails', async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-runtime-policy-disposal-failure-'));
  const root = join(base, 'interactive');
  const capability = await resolveStorageRoot({ path: root, kind: 'interactive' });
  const owner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(owner);
  if (!owner) return;

  let drainRequests = 0;
  let composition: Awaited<ReturnType<typeof createExecutionRuntimeHostComposition>> | undefined;
  let disposalSpy: ReturnType<typeof mock.method> | undefined;
  const activationGates: RuntimePolicyActivationGate[] = [];
  const originalRunBackendActivation = RuntimePolicyActivationGate.prototype.runBackendActivation;
  const activationSpy = mock.method(
    RuntimePolicyActivationGate.prototype,
    'runBackendActivation',
    function <T>(this: RuntimePolicyActivationGate, operation: () => Promise<T> | T): Promise<T> {
      activationGates.push(this);
      return Reflect.apply(originalRunBackendActivation, this, [operation]) as Promise<T>;
    },
  );
  try {
    const setupStores = await openInteractiveExecutionStoresForWrite(owner.lease);
    const session = await setupStores.sessionStore.create({
      cwd: root,
      backend: 'fake',
      llmConnectionSlug: 'fake',
      model: 'fake-model',
      permissionMode: 'ask',
    });

    composition = await createExecutionRuntimeHostComposition({
      owner,
      hostEpoch: context.hostEpoch,
      acquireResidency: context.acquireResidency,
      retainUntilProcessExit: () => undefined,
      requestDrain: () => {
        drainRequests += 1;
      },
    });
    await composition.recover();

    const firstTurnId = randomUUID();
    const started = await composition.handlers['turn.start'](
      {
        sessionId: session.id,
        turnId: firstTurnId,
        content: { text: 'cache this backend' },
      },
      context,
    );
    assert.equal(started.ok, true);
    if (!started.ok) return;
    assert.equal(started.result.kind, 'started');
    if (started.result.kind !== 'started') return;
    let snapshot = started.result.turn;
    for (let attempt = 0; attempt < 100 && !isTerminalTurnStatus(snapshot.status); attempt += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
      const queried = await composition.handlers['turn.query'](
        { sessionId: session.id, turnId: firstTurnId },
        context,
      );
      assert.equal(queried.ok, true);
      if (!queried.ok) return;
      snapshot = queried.result;
    }
    assert.equal(isTerminalTurnStatus(snapshot.status), true);

    disposalSpy = mock.method(FakeBackend.prototype, 'dispose', async () => {
      throw new Error('injected cached backend disposal failure');
    });
    const initial = await composition.handlers['runtime.policy.query']({}, context);
    assert.equal(initial.ok, true);
    if (!initial.ok) return;
    const mutated = await composition.handlers['runtime.policy.mutate'](
      {
        expectedRevision: initial.result.revision,
        operation: {
          kind: 'set_memory',
          value: { enabled: false, agentReadEnabled: false },
        },
      },
      context,
    );

    assert.deepEqual(mutated, {
      ok: true,
      result: { kind: 'committed', revision: initial.result.revision + 1 },
    });
    await waitFor(() => drainRequests === 1, 'backend disposal failure drain');
    assert.equal(drainRequests, 1);
    assert.equal(activationGates.length, 1);
    await assert.rejects(
      () => activationGates[0]!.runBackendActivation(async () => undefined),
      /Runtime policy activation is poisoned/,
    );
    assert.equal(drainRequests, 1);
  } finally {
    activationSpy.mock.restore();
    disposalSpy?.mock.restore();
    try {
      await composition?.close();
    } finally {
      try {
        await owner.close();
      } finally {
        await rm(base, { recursive: true, force: true });
      }
    }
  }
});

test('projects runtime policy CAS results without returning the committed snapshot', async () => {
  let invalidations = 0;
  await withCoordinator(async ({ stores }) => {
    const coordinator = new HostRuntimePolicyCoordinator(
      stores,
      new RuntimePolicyActivationGate(),
      async () => {
        invalidations += 1;
      },
    );
    const initial = await coordinator.handlers['runtime.policy.query']({}, context);
    assert.equal(initial.ok, true);
    if (!initial.ok) return;

    const committed = await coordinator.handlers['runtime.policy.mutate'](
      {
        expectedRevision: initial.result.revision,
        operation: {
          kind: 'set_personalization',
          value: { displayName: 'Runtime Host', assistantTone: 'precise' },
        },
      },
      context,
    );
    assert.deepEqual(committed, { ok: true, result: { kind: 'committed', revision: 1 } });
    assert.equal(invalidations, 1);

    const conflict = await coordinator.handlers['runtime.policy.mutate'](
      {
        expectedRevision: initial.result.revision,
        operation: {
          kind: 'set_memory',
          value: { enabled: false, agentReadEnabled: false },
        },
      },
      context,
    );
    assert.deepEqual(conflict, {
      ok: true,
      result: { kind: 'revision_conflict', expectedRevision: 0, actualRevision: 1 },
    });
    assert.equal(invalidations, 1);
  });
});

test('awaits committed mutation invalidation before returning the outcome', async () => {
  await withCoordinator(async ({ stores }) => {
    let releaseInvalidation!: () => void;
    const invalidation = new Promise<void>((resolve) => {
      releaseInvalidation = resolve;
    });
    const coordinator = new HostRuntimePolicyCoordinator(
      stores,
      new RuntimePolicyActivationGate(),
      () => invalidation,
    );
    let settled = false;
    const mutation = coordinator.handlers['runtime.policy.mutate'](
      {
        expectedRevision: 0,
        operation: {
          kind: 'set_memory',
          value: { enabled: false, agentReadEnabled: false },
        },
      },
      context,
    );
    void mutation.finally(() => {
      settled = true;
    });

    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(settled, false);
    releaseInvalidation();
    assert.deepEqual(await mutation, {
      ok: true,
      result: { kind: 'committed', revision: 1 },
    });
  });
});

test('preserves a committed mutation outcome when invalidation fails', async () => {
  await withCoordinator(async ({ stores }) => {
    let invalidations = 0;
    const coordinator = new HostRuntimePolicyCoordinator(
      stores,
      new RuntimePolicyActivationGate(),
      async () => {
        invalidations += 1;
        throw new Error('injected invalidation failure after commit');
      },
    );

    assert.deepEqual(
      await coordinator.handlers['runtime.policy.mutate'](
        {
          expectedRevision: 0,
          operation: {
            kind: 'set_memory',
            value: { enabled: false, agentReadEnabled: false },
          },
        },
        context,
      ),
      { ok: true, result: { kind: 'committed', revision: 1 } },
    );
    assert.equal(invalidations, 1);
    assert.equal((await stores.runtimePolicy.getSnapshot()).revision, 1);
    await assert.rejects(() =>
      coordinator.handlers['runtime.policy.mutate'](
        {
          expectedRevision: 1,
          operation: {
            kind: 'set_memory',
            value: { enabled: true, agentReadEnabled: true },
          },
        },
        context,
      ),
    );
    assert.equal((await stores.runtimePolicy.getSnapshot()).revision, 1);
  });
});

test('invalidates when a real published mutation loses its commit reply', {
  skip: process.platform === 'win32',
}, async () => {
  await withCoordinator(async ({ stores, root }) => {
    let invalidations = 0;
    const coordinator = new HostRuntimePolicyCoordinator(
      stores,
      new RuntimePolicyActivationGate(),
      async () => {
        invalidations += 1;
        throw new Error('injected invalidation failure after unknown commit');
      },
    );
    const probe = await open(root, 'r');
    const fileHandlePrototype = Object.getPrototypeOf(probe) as {
      sync: typeof probe.sync;
    };
    const originalSync = fileHandlePrototype.sync;
    await probe.close();
    let syncCalls = 0;
    const syncMock = mock.method(fileHandlePrototype, 'sync', async function (this: typeof probe) {
      syncCalls += 1;
      if (syncCalls === 2) throw new Error('injected directory sync reply loss');
      return originalSync.call(this);
    });

    const outcome = await (async () => {
      try {
        return await coordinator.handlers['runtime.policy.mutate'](
          {
            expectedRevision: 0,
            operation: {
              kind: 'set_personalization',
              value: { displayName: 'Published', assistantTone: 'unknown-reply' },
            },
          },
          context,
        );
      } finally {
        syncMock.mock.restore();
      }
    })();

    assert.deepEqual(outcome, {
      ok: false,
      error: {
        code: 'commit_outcome_unknown',
        message: 'Runtime policy commit outcome is unknown',
      },
    });
    assert.equal(syncCalls, 2);
    assert.equal(invalidations, 1);
    const published = await stores.runtimePolicy.getSnapshot();
    assert.equal(published.revision, 1);
    assert.deepEqual(published.policy.personalization, {
      displayName: 'Published',
      assistantTone: 'unknown-reply',
    });
  });
});

test('credential control-plane results never retain or expose secret material', async () => {
  await withCoordinator(async ({ coordinator, stores }) => {
    const locator: CredentialLocator = { scope: 'network_proxy', kind: 'password' };
    const secret = 'runtime-host-secret-that-must-not-escape';
    const set = await coordinator.handlers['credential.vault.set'](
      { locator, expected: null, secret },
      context,
    );
    assert.equal(set.ok, true);
    if (!set.ok || set.result.kind !== 'committed') return;
    assert.equal(set.result.status.configured, true);
    assert.equal(JSON.stringify(set).includes(secret), false);

    const queried = await coordinator.handlers['credential.vault.query']({ locator }, context);
    assert.equal(queried.ok, true);
    if (!queried.ok || queried.result.kind !== 'status') return;
    assert.deepEqual(queried.result.status, set.result.status);
    assert.equal(JSON.stringify(queried).includes(secret), false);
    if (!queried.result.status.configured) return;

    const deleted = await coordinator.handlers['credential.vault.delete'](
      {
        expected: {
          locator,
          credentialId: queried.result.status.credentialId,
          revision: queried.result.status.revision,
        },
      },
      context,
    );
    assert.equal(deleted.ok, true);
    if (!deleted.ok || deleted.result.kind !== 'committed') return;
    assert.deepEqual(deleted.result.status, {
      locator,
      configured: false,
      credentialId: null,
      revision: null,
      updatedAt: null,
    });
    assert.equal(JSON.stringify(deleted).includes(secret), false);

    const created = await stores.connectionCatalog.create({
      expectedCatalogRevision: 0,
      connection: {
        slug: 'custom-headers',
        name: 'Custom headers',
        providerType: 'openrouter',
        enabled: true,
        enabledModelIds: ['deepseek/deepseek-v4-flash-0731'],
      },
    });
    assert.equal(created.kind, 'committed');
    if (created.kind !== 'committed') return;
    const connectionId = created.snapshot.connections[0]!.connectionId;
    const headerSecret = 'request-header-secret-that-must-not-escape';
    const replaced = await coordinator.handlers['connection.request-headers.replace'](
      {
        connectionId,
        headers: [{ name: 'X-Tenant', value: headerSecret }],
      },
      context,
    );
    assert.deepEqual(replaced, {
      ok: true,
      result: { kind: 'committed', names: ['X-Tenant'] },
    });
    assert.equal(JSON.stringify(replaced).includes(headerSecret), false);
    assert.deepEqual(
      await coordinator.handlers['connection.request-headers.query']({ connectionId }, context),
      { ok: true, result: { kind: 'found', names: ['X-Tenant'] } },
    );
  });
});

test('projects state-dependent OAuth endpoint overrides as invalid requests', async () => {
  await withCoordinator(async ({ coordinator, stores }) => {
    const created = await stores.connectionCatalog.create({
      expectedCatalogRevision: 0,
      connection: {
        slug: 'github-copilot',
        name: 'GitHub Copilot',
        providerType: 'github-copilot',
        enabled: true,
        enabledModelIds: [],
      },
    });
    assert.equal(created.kind, 'committed');
    if (created.kind !== 'committed') return;
    const connection = created.snapshot.connections[0];
    assert.ok(connection);
    if (!connection) return;

    const updated = await coordinator.handlers['connection.catalog.update'](
      {
        expected: { connectionId: connection.connectionId, revision: connection.revision },
        changes: {
          name: connection.name,
          baseUrl: 'https://copilot.example.test/v1',
          enabled: connection.enabled,
          enabledModelIds: connection.enabledModelIds,
          relayModelProfiles: null,
        },
      },
      context,
    );

    assert.deepEqual(updated, {
      ok: false,
      error: {
        code: 'invalid_request',
        message: 'Runtime policy mutation is invalid for the current state',
      },
    });
  });
});

test('returns connection_not_found when deleting a credential after its connection is removed', async () => {
  await withCoordinator(async ({ coordinator, stores }) => {
    const created = await stores.connectionCatalog.create({
      expectedCatalogRevision: 0,
      connection: {
        slug: 'credential-owner',
        name: 'Credential owner',
        providerType: 'openai',
        enabled: true,
        enabledModelIds: [],
      },
    });
    assert.equal(created.kind, 'committed');
    if (created.kind !== 'committed') return;
    const connection = created.snapshot.connections[0];
    assert.ok(connection);
    if (!connection) return;
    const locator: CredentialLocator = {
      scope: 'connection',
      connectionId: connection.connectionId,
      kind: 'api_key',
    };
    const configured = await stores.credentialVault.set({
      locator,
      expected: null,
      secret: 'deleted-connection-secret',
    });
    assert.equal(configured.kind, 'committed');
    if (configured.kind !== 'committed') return;
    const status = configured.snapshot.entries[0];
    assert.ok(status?.configured);
    if (!status?.configured) return;

    const removed = await stores.connectionCatalog.remove({
      expected: { connectionId: connection.connectionId, revision: connection.revision },
    });
    assert.equal(removed.kind, 'committed');

    const deleted = await coordinator.handlers['credential.vault.delete'](
      {
        expected: {
          locator,
          credentialId: status.credentialId,
          revision: status.revision,
        },
      },
      context,
    );
    assert.deepEqual(deleted, { ok: true, result: { kind: 'connection_not_found' } });
  });
});

test('a fully profiled relay catalog paginates with profiles riding per item', async () => {
  await withCoordinator(async ({ coordinator, stores }) => {
    // Every claim in one header table used to be what made a long catalog
    // unreadable: the header item is atomic to the paginator. Profiles now
    // travel with their own enabled_model_id item, so a connection whose
    // EVERY enabled model declares a full profile must still paginate.
    const modelIds = Array.from({ length: 40 }, (_, index) => `relay-model-${index}`);
    const profiles = Object.fromEntries(
      modelIds.map((modelId) => [
        modelId,
        {
          thinkingLevels: ['low', 'high'] as ('low' | 'high')[],
          vision: true,
          contextWindow: 131_072,
        },
      ]),
    );
    const created = await stores.connectionCatalog.create({
      expectedCatalogRevision: 0,
      connection: {
        slug: 'profiled-relay',
        name: 'Profiled relay',
        providerType: 'openai-compatible',
        baseUrl: 'https://relay.example/v1',
        enabled: true,
        enabledModelIds: modelIds,
        relayModelProfiles: profiles,
      },
    });
    assert.equal(created.kind, 'committed');
    if (created.kind !== 'committed') return;

    const seen: Extract<ConnectionCatalogPageItem, { kind: 'enabled_model_id' }>[] = [];
    const first = await coordinator.handlers['connection.catalog.query'](
      { kind: 'start' },
      context,
    );
    assert.equal(first.ok, true);
    if (!first.ok || first.result.kind !== 'page') return;
    const queue = [first.result];
    while (queue.length > 0) {
      const observed = queue.pop()!;
      assert.ok(
        Buffer.byteLength(JSON.stringify(observed), 'utf8') <= CONNECTION_CATALOG_PAGE_MAX_BYTES,
      );
      for (const item of observed.items) {
        if (item.kind === 'connection') {
          assert.ok(!('relayModelProfiles' in item), 'header must not carry the profile table');
        }
        if (item.kind === 'enabled_model_id') seen.push(item);
      }
      if (observed.nextCursor) {
        const next = await coordinator.handlers['connection.catalog.query'](
          { kind: 'continue', revision: observed.revision, cursor: observed.nextCursor },
          context,
        );
        assert.equal(next.ok, true);
        if (!next.ok || next.result.kind !== 'page') return;
        queue.push(next.result);
      }
    }
    assert.equal(seen.length, modelIds.length);
    for (const item of seen) {
      assert.deepEqual(item.relayProfile, profiles[item.modelId]);
    }
  });
});

test('catalog protocol preserves an extra request body after a committed update', async () => {
  await withCoordinator(async ({ coordinator, stores }) => {
    const emptyBodyBytes = Buffer.byteLength(JSON.stringify({ padding: '' }), 'utf8');
    const requestBodyOverlay = {
      padding: 'x'.repeat(REQUEST_BODY_OVERLAY_MAX_BYTES - emptyBodyBytes),
    };
    assert.equal(
      Buffer.byteLength(JSON.stringify(requestBodyOverlay), 'utf8'),
      REQUEST_BODY_OVERLAY_MAX_BYTES,
    );
    const created = await stores.connectionCatalog.create({
      expectedCatalogRevision: 0,
      connection: {
        slug: 'custom-request',
        name: 'Custom request',
        providerType: 'openai-compatible',
        baseUrl: `https://example.test/${'a'.repeat(2_048 - 'https://example.test/'.length)}`,
        enabled: true,
        enabledModelIds: ['deepseek/deepseek-v4-flash-0731'],
        requestBodyOverlay,
      },
    });
    assert.equal(created.kind, 'committed');

    const queried = await coordinator.handlers['connection.catalog.query'](
      { kind: 'start' },
      context,
    );
    assert.equal(queried.ok, true);
    if (!queried.ok || queried.result.kind !== 'page') return;

    const decoded = RUNTIME_POLICY_OPERATION_SPECS['connection.catalog.query'].decodeOutput(
      queried.result,
    );
    assert.deepEqual(decoded, queried.result);
    const header =
      decoded.kind === 'page'
        ? decoded.items.find((item) => item.kind === 'connection')
        : undefined;
    assert.deepEqual(header?.requestBodyOverlay, requestBodyOverlay);
  });
});

test('projects a corrupted runtime policy document as persistence_failed on query', async () => {
  await withCoordinator(async ({ coordinator, root }) => {
    await writeFile(join(root, 'runtime-policy.json'), '{not-json', 'utf8');

    const queried = await coordinator.handlers['runtime.policy.query']({}, context);

    assert.deepEqual(queried, {
      ok: false,
      error: {
        code: 'persistence_failed',
        message: 'Runtime policy persistence failed',
      },
    });
  });
});

test('reconstructs a large catalog with revision-pinned pages and rejects stale cursors', async () => {
  await withCoordinator(async ({ coordinator, stores }) => {
    for (let connectionIndex = 0; connectionIndex < 5; connectionIndex += 1) {
      const current = await stores.connectionCatalog.getSnapshot();
      const result = await stores.connectionCatalog.create({
        expectedCatalogRevision: current.revision,
        connection: largeConnection(connectionIndex),
      });
      assert.equal(result.kind, 'committed');
    }

    const snapshot = await stores.connectionCatalog.getSnapshot();
    assert.ok(
      Buffer.byteLength(JSON.stringify(snapshot), 'utf8') > CONNECTION_CATALOG_PAGE_MAX_BYTES,
    );
    const first = await coordinator.handlers['connection.catalog.query'](
      { kind: 'start' },
      context,
    );
    assert.equal(first.ok, true);
    if (!first.ok || first.result.kind !== 'page') return;

    const pages = [first.result];
    while (pages.at(-1)?.nextCursor) {
      const previous = pages.at(-1);
      assert.ok(previous?.nextCursor);
      if (!previous?.nextCursor) break;
      const next = await coordinator.handlers['connection.catalog.query'](
        {
          kind: 'continue',
          revision: first.result.revision,
          cursor: previous.nextCursor,
        },
        context,
      );
      assert.equal(next.ok, true);
      if (!next.ok || next.result.kind !== 'page') return;
      pages.push(next.result);
    }

    assert.ok(pages.length > 1);
    for (const page of pages) {
      assert.equal(page.revision, snapshot.revision);
      assert.equal(page.connectionCount, snapshot.connections.length);
      assert.ok(page.items.length <= CONNECTION_CATALOG_PAGE_MAX_ITEMS);
      assert.ok(
        Buffer.byteLength(JSON.stringify(page), 'utf8') <= CONNECTION_CATALOG_PAGE_MAX_BYTES,
      );
    }
    assert.deepEqual(
      pages.flatMap((page) => page.items),
      expectedCatalogItems(snapshot),
    );

    const staleCursor = first.result.nextCursor;
    assert.ok(staleCursor);
    if (!staleCursor) return;
    const appended = await stores.connectionCatalog.create({
      expectedCatalogRevision: snapshot.revision,
      connection: {
        slug: 'after-first-page',
        name: 'After first page',
        providerType: 'openai',
        enabled: true,
        enabledModelIds: [],
      },
    });
    assert.equal(appended.kind, 'committed');

    const changed = await coordinator.handlers['connection.catalog.query'](
      {
        kind: 'continue',
        revision: snapshot.revision,
        cursor: staleCursor,
      },
      context,
    );
    assert.deepEqual(changed, {
      ok: true,
      result: {
        kind: 'revision_changed',
        expectedRevision: snapshot.revision,
        actualRevision: snapshot.revision + 1,
      },
    });

    const invalid = await coordinator.handlers['connection.catalog.query'](
      {
        kind: 'continue',
        revision: snapshot.revision + 1,
        cursor: { connectionIndex: 999, part: 'connection' },
      },
      context,
    );
    assert.deepEqual(invalid, {
      ok: false,
      error: { code: 'invalid_request', message: 'Invalid connection catalog cursor' },
    });
  });
});

function isTerminalTurnStatus(status: string): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

function largeConnection(connectionIndex: number): ConnectionCatalogEntryDraft {
  return {
    slug: `large-${connectionIndex}`,
    name: `Large connection ${connectionIndex}`,
    providerType: 'openai',
    enabled: true,
    enabledModelIds: Array.from(
      { length: 128 },
      (_, itemIndex) => `model-${connectionIndex}-${itemIndex}-${'x'.repeat(300)}`,
    ),
  };
}

function expectedCatalogItems(snapshot: ConnectionCatalogSnapshot): ConnectionCatalogPageItem[] {
  const items: ConnectionCatalogPageItem[] = [];
  for (const [connectionIndex, connection] of snapshot.connections.entries()) {
    // Mirror `projectCatalogItems`: profiles ride on their enabled_model_id
    // item, never in one header table (a header item is atomic to the
    // paginator — a long declaration list would make it unsplittable).
    const { enabledModelIds, models, relayModelProfiles, ...header } = connection;
    items.push({
      kind: 'connection',
      connectionIndex,
      ...header,
      enabledModelIdCount: enabledModelIds.length,
      modelCount: models.length,
    });
    for (const [itemIndex, modelId] of enabledModelIds.entries()) {
      const relayProfile = relayModelProfiles?.[modelId];
      items.push({
        kind: 'enabled_model_id',
        connectionIndex,
        itemIndex,
        modelId,
        ...(relayProfile === undefined ? {} : { relayProfile }),
      });
    }
    for (const [itemIndex, model] of models.entries()) {
      items.push({ kind: 'model', connectionIndex, itemIndex, model });
    }
  }
  return items;
}

type Stores = Awaited<ReturnType<typeof openInteractiveRuntimePolicyStoresForWrite>>;

async function withCoordinator(
  run: (input: {
    coordinator: HostRuntimePolicyCoordinator;
    stores: Stores;
    root: string;
  }) => Promise<void>,
): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), 'maka-runtime-policy-host-'));
  const root = join(base, 'interactive');
  const capability = await resolveStorageRoot({
    path: root,
    kind: 'interactive',
  });
  const owner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(owner);
  if (!owner) return;
  try {
    const stores = await openInteractiveRuntimePolicyStoresForWrite(owner.lease);
    await run({
      coordinator: new HostRuntimePolicyCoordinator(stores, new RuntimePolicyActivationGate()),
      stores,
      root,
    });
  } finally {
    await owner.close();
    await rm(base, { recursive: true, force: true });
  }
}

async function settlesWithin<T>(promise: Promise<T>, label: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`${label} did not settle`)), 2_000);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`${label} did not occur`);
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}
