import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { test } from 'node:test';

import {
  ExtensionLifecycleKernel,
  ExtensionLifecycleOperationError,
  type ExtensionActivationContext,
  type ExtensionLifecycleErrorCode,
  type ExtensionRevisionDefinition,
} from '../extension-lifecycle-kernel.js';

test('system: a real TCP provider is health-checked, consumed, restarted, and fully released', async () => {
  const kernel = new ExtensionLifecycleKernel();
  const events: string[] = [];
  const providerPorts: number[] = [];
  const consumerReplies: string[] = [];

  await kernel.install(tcpProviderRevision('tcp-provider', '1', providerPorts, events));
  await kernel.install({
    extensionId: 'tcp-consumer',
    revision: '1',
    dependencies: [{ extensionId: 'tcp-provider' }],
    prepare: () => ({
      activate: async (context) => {
        const endpoint = context.dependency<TcpEndpoint>('tcp-provider');
        const socket = createConnection({ host: '127.0.0.1', port: endpoint.port });
        context.ownEffect('tcp-client', async () => {
          events.push(`consumer:${endpoint.instance}:close`);
          await destroySocket(socket);
        });
        await once(socket, 'connect');
        socket.write('keep');
        consumerReplies.push(await nextData(socket));
        events.push(`consumer:${endpoint.instance}:active`);
      },
    }),
  });

  const waiting = await kernel.activate(
    binding('consumer-binding', 'session-system', 'tcp-consumer', '1'),
  );
  assert.equal(waiting.status, 'waiting');

  await kernel.activate(binding('provider-binding', 'session-system', 'tcp-provider', '1'));
  assert.equal(kernel.inspect('consumer-binding').status, 'active');
  assert.deepEqual(consumerReplies, ['pong:1:1']);
  const firstPort = providerPorts[0]!;
  assert.equal(await request(firstPort, 'health'), 'healthy:1:1');

  events.length = 0;
  await kernel.stop('provider-binding');
  assert.deepEqual(events, ['consumer:1:close', 'provider:1:close']);
  await assert.rejects(request(firstPort, 'health'));
  assert.equal(kernel.inspect('consumer-binding').status, 'waiting');

  await kernel.start('provider-binding');
  assert.equal(kernel.inspect('provider-binding').status, 'active');
  assert.equal(kernel.inspect('consumer-binding').status, 'active');
  assert.deepEqual(consumerReplies, ['pong:1:1', 'pong:1:2']);
  assert.equal(await request(providerPorts[1]!, 'health'), 'healthy:1:2');

  const secondPort = providerPorts[1]!;
  await kernel.disposeScope('session-system');
  await assert.rejects(request(secondPort, 'health'));
  assert.deepEqual(kernel.inspectScope('session-system'), []);
  assert.deepEqual(kernel.composition('session-system').entries, []);
});

test('system: real event listeners and timers do not survive stop or restart', async () => {
  const kernel = new ExtensionLifecycleKernel();
  const bus = new EventEmitter();
  let messages = 0;
  let ticks = 0;

  await kernel.install({
    extensionId: 'event-worker',
    revision: '1',
    prepare: () => ({
      activate: (context) => {
        const listener = () => {
          messages += 1;
        };
        bus.on('message', listener);
        context.ownEffect('event-listener', () => {
          bus.off('message', listener);
        });
        const timer = setInterval(() => {
          ticks += 1;
        }, 2);
        context.ownEffect('timer', () => clearInterval(timer));
      },
    }),
  });

  await kernel.activate(binding('worker-binding', 'session-resources', 'event-worker', '1'));
  bus.emit('message');
  await waitFor(() => ticks > 0);
  assert.equal(messages, 1);
  assert.equal(bus.listenerCount('message'), 1);

  await kernel.stop('worker-binding');
  const stoppedTicks = ticks;
  bus.emit('message');
  await delay(15);
  assert.equal(messages, 1);
  assert.equal(ticks, stoppedTicks);
  assert.equal(bus.listenerCount('message'), 0);

  await kernel.start('worker-binding');
  bus.emit('message');
  await waitFor(() => ticks > stoppedTicks);
  assert.equal(messages, 2);
  assert.equal(bus.listenerCount('message'), 1);
  await kernel.removeBinding('worker-binding');
  assert.equal(bus.listenerCount('message'), 0);
});

test('system: a diamond dependency graph moves atomically to the new provider value', async () => {
  const kernel = new ExtensionLifecycleKernel();
  const events: string[] = [];
  const workerValues: string[] = [];

  await kernel.install(valueRevision('database', '1', 'db-v1', events));
  await kernel.install(valueRevision('database', '2', 'db-v2', events));
  await kernel.install(derivedRevision('api', ['database'], events));
  await kernel.install(derivedRevision('cache', ['database'], events));
  await kernel.install({
    extensionId: 'worker',
    revision: '1',
    dependencies: [{ extensionId: 'api' }, { extensionId: 'cache' }],
    prepare: () => ({
      activate: (context) => {
        const value = `${context.dependency<string>('api')}+${context.dependency<string>('cache')}`;
        workerValues.push(value);
        events.push(`worker:activate:${value}`);
        context.ownEffect('worker', () => {
          events.push('worker:dispose');
        });
      },
    }),
  });

  await kernel.activate(binding('d-worker', 'session-graph', 'worker', '1'));
  await kernel.activate(binding('b-api', 'session-graph', 'api', '1'));
  await kernel.activate(binding('c-cache', 'session-graph', 'cache', '1'));
  await kernel.activate(binding('a-database', 'session-graph', 'database', '1'));
  assert.deepEqual(workerValues, ['api(db-v1@1)+cache(db-v1@1)']);

  events.length = 0;
  const before = kernel.composition('session-graph');
  await kernel.update('a-database', '2');
  const after = kernel.composition('session-graph');

  assert.deepEqual(events, [
    'worker:dispose',
    'api:dispose',
    'cache:dispose',
    'database:2:activate',
    'database:1:dispose',
    'api:activate:db-v2@2',
    'cache:activate:db-v2@2',
    'worker:activate:api(db-v2@2)+cache(db-v2@2)',
  ]);
  assert.deepEqual(workerValues, ['api(db-v1@1)+cache(db-v1@1)', 'api(db-v2@2)+cache(db-v2@2)']);
  assert.equal(before.entries.find((entry) => entry.extensionId === 'database')?.revision, '1');
  assert.equal(after.entries.find((entry) => entry.extensionId === 'database')?.revision, '2');
  assert.notEqual(before.digest, after.digest);
  assert.ok(kernel.inspectScope('session-graph').every((item) => item.status === 'active'));
});

test('system: a dependent cleanup failure blocks provider cutover and is recoverable', async () => {
  const kernel = new ExtensionLifecycleKernel();
  let cleanupAttempts = 0;
  const values: string[] = [];
  await kernel.install(valueRevision('provider', '1', 'old', []));
  await kernel.install(valueRevision('provider', '2', 'new', []));
  await kernel.install({
    extensionId: 'consumer',
    revision: '1',
    dependencies: [{ extensionId: 'provider' }],
    prepare: () => ({
      activate: (context) => {
        values.push(context.dependency<string>('provider'));
        context.ownEffect('flaky-consumer', () => {
          cleanupAttempts += 1;
          if (cleanupAttempts === 1) throw new Error('busy');
        });
      },
    }),
  });
  await kernel.activate(binding('a-provider', 'session-retry', 'provider', '1'));
  await kernel.activate(binding('b-consumer', 'session-retry', 'consumer', '1'));

  await assertCode(kernel.update('a-provider', '2'), 'cleanup_failed');
  assert.equal(kernel.inspect('a-provider').current?.revision, '1');
  assert.equal(kernel.inspect('b-consumer').status, 'failed');
  assert.equal(kernel.inspect('b-consumer').pendingCleanupEffects, 1);

  await kernel.retry('b-consumer');
  assert.equal(kernel.inspect('b-consumer').status, 'active');
  assert.equal(
    kernel.inspect('a-provider').desiredRevision,
    '2',
    'the failed update remains desired and the scope converges after cleanup retry',
  );
  assert.equal(kernel.inspect('a-provider').current?.revision, '2');
  assert.equal(kernel.inspect('b-consumer').status, 'active');
  assert.deepEqual(values, ['old', 'new']);
});

test('system: failed candidate cleanup is retained, retried, and leaves no duplicate resource', async () => {
  const kernel = new ExtensionLifecycleKernel();
  let activationAttempts = 0;
  let cleanupAttempts = 0;
  let liveResources = 0;
  await kernel.install({
    extensionId: 'candidate-recovery',
    revision: '1',
    prepare: (context) => {
      liveResources += 1;
      context.ownEffect('candidate-resource', () => {
        cleanupAttempts += 1;
        if (cleanupAttempts === 1) throw new Error('temporarily locked');
        liveResources -= 1;
      });
      return {
        activate: () => {
          activationAttempts += 1;
          if (activationAttempts === 1) throw new Error('first activation fails');
        },
      };
    },
  });

  await assertCode(
    kernel.activate(binding('recovery-binding', 'session-recovery', 'candidate-recovery', '1')),
    'cleanup_failed',
  );
  assert.equal(liveResources, 1);
  assert.equal(kernel.inspect('recovery-binding').pendingCleanupEffects, 1);

  await kernel.retry('recovery-binding');
  assert.equal(liveResources, 1, 'the retired resource is released before the retry allocates one');
  assert.equal(kernel.inspect('recovery-binding').status, 'active');
  await kernel.stop('recovery-binding');
  assert.equal(liveResources, 0);
});

test('system: disposeScope is retryable after a real cleanup failure', async () => {
  const kernel = new ExtensionLifecycleKernel();
  const bus = new EventEmitter();
  let attempts = 0;
  const listener = () => undefined;
  await kernel.install({
    extensionId: 'scope-resource',
    revision: '1',
    prepare: () => ({
      activate: (context) => {
        bus.on('data', listener);
        context.ownEffect('listener', () => {
          attempts += 1;
          if (attempts === 1) throw new Error('temporary release failure');
          bus.off('data', listener);
        });
      },
    }),
  });
  await kernel.activate(binding('scope-binding', 'session-dispose', 'scope-resource', '1'));

  await assertCode(kernel.disposeScope('session-dispose'), 'cleanup_failed');
  assert.equal(bus.listenerCount('data'), 1);
  assert.equal(kernel.inspect('scope-binding').status, 'failed');
  await kernel.disposeScope('session-dispose');
  assert.equal(bus.listenerCount('data'), 0);
  assert.deepEqual(kernel.inspectScope('session-dispose'), []);
});

test('system: public error paths preserve state and the serialized queue remains usable', async () => {
  const kernel = new ExtensionLifecycleKernel();
  const valid = valueRevision('valid', '1', 'value', []);

  for (const definition of [
    null,
    { extensionId: 'Bad', revision: '1', prepare: () => ({ activate: () => undefined }) },
    { extensionId: 'missing-prepare', revision: '1' },
    { ...valid, revision: '' },
    { ...valid, dependencies: [{ extensionId: 'valid' }] },
    { ...valid, dependencies: [{ extensionId: 'dep' }, { extensionId: 'dep' }] },
    {
      ...valid,
      contributions: [
        { id: 'same', kind: 'fake' },
        { id: 'same', kind: 'fake' },
      ],
    },
  ]) {
    await assertCode(
      kernel.install(definition as ExtensionRevisionDefinition),
      'invalid_definition',
    );
  }

  await kernel.install(valid);
  await assertCode(kernel.install(valid), 'revision_already_installed');
  await assertCode(kernel.uninstall('valid', 'missing'), 'revision_not_installed');
  await assertCode(
    kernel.activate(binding('missing-revision', 'session-errors', 'valid', '2')),
    'revision_not_installed',
  );
  await assertCode(kernel.update('missing-binding', '1'), 'binding_not_found');
  assert.throws(() => kernel.inspect('missing-binding'), hasCode('binding_not_found'));

  await kernel.activate(binding('valid-binding', 'session-errors', 'valid', '1'));
  await assertCode(
    kernel.activate(binding('valid-binding', 'other-scope', 'valid', '1')),
    'binding_conflict',
  );
  await assertCode(
    kernel.activate(binding('other-binding', 'session-errors', 'valid', '1')),
    'binding_conflict',
  );
  assert.equal(kernel.inspect('valid-binding').status, 'active');

  await kernel.stop('valid-binding');
  await kernel.start('valid-binding');
  assert.equal(kernel.inspect('valid-binding').status, 'active');
});

test('system: effect registration is validated and sealed after activation', async () => {
  const kernel = new ExtensionLifecycleKernel();
  let retainedContext: ExtensionActivationContext | undefined;
  await kernel.install({
    extensionId: 'bad-effect',
    revision: '1',
    prepare: () => ({
      activate: (context) => context.ownEffect('', () => undefined),
    }),
  });
  await assertCode(
    kernel.activate(binding('bad-effect-binding', 'session-effects', 'bad-effect', '1')),
    'invalid_definition',
  );

  await kernel.install({
    extensionId: 'sealed-effect',
    revision: '1',
    prepare: () => ({
      activate: (context) => {
        retainedContext = context;
      },
    }),
  });
  await kernel.activate(binding('sealed-binding', 'session-effects', 'sealed-effect', '1'));
  assert.throws(
    () => retainedContext!.ownEffect('too-late', () => undefined),
    hasCode('activation_failed'),
  );
});

test('system: invalid prepared candidates and unavailable dependency reads roll back cleanly', async () => {
  const kernel = new ExtensionLifecycleKernel();
  await kernel.install({
    extensionId: 'invalid-candidate',
    revision: '1',
    prepare: () => null as never,
  });
  await assertCode(
    kernel.activate(binding('invalid-binding', 'session-invalid', 'invalid-candidate', '1')),
    'invalid_definition',
  );
  assert.equal(kernel.composition('session-invalid').entries.length, 0);

  await kernel.install({
    extensionId: 'missing-value',
    revision: '1',
    prepare: () => ({
      activate: (context) => {
        context.dependency('not-active');
      },
    }),
  });
  await assertCode(
    kernel.activate(binding('missing-value-binding', 'session-invalid', 'missing-value', '1')),
    'activation_failed',
  );

  await kernel.install({
    extensionId: 'missing-revision-read',
    revision: '1',
    prepare: () => ({
      activate: (context) => {
        context.dependencyRevision('not-active');
      },
    }),
  });
  await assertCode(
    kernel.activate(
      binding('missing-revision-binding', 'session-invalid', 'missing-revision-read', '1'),
    ),
    'activation_failed',
  );
});

test('system: remove and repeated cleanup failures retain ownership until release succeeds', async () => {
  const kernel = new ExtensionLifecycleKernel();
  let removeAttempts = 0;
  await kernel.install({
    extensionId: 'remove-retry',
    revision: '1',
    prepare: () => ({
      activate: (context) => {
        context.ownEffect('remove-resource', () => {
          removeAttempts += 1;
          if (removeAttempts === 1) throw new Error('first release fails');
        });
      },
    }),
  });
  await kernel.activate(binding('remove-binding', 'session-remove', 'remove-retry', '1'));
  await assertCode(kernel.removeBinding('remove-binding'), 'cleanup_failed');
  assert.equal(kernel.inspect('remove-binding').pendingCleanupEffects, 1);
  await kernel.removeBinding('remove-binding');
  assert.throws(() => kernel.inspect('remove-binding'), hasCode('binding_not_found'));

  let persistentAttempts = 0;
  await kernel.install({
    extensionId: 'persistent-cleanup',
    revision: '1',
    prepare: () => ({
      activate: (context) => {
        context.ownEffect('persistent-resource', () => {
          persistentAttempts += 1;
          if (persistentAttempts < 3) throw new Error('still busy');
        });
      },
    }),
  });
  await kernel.activate(binding('persistent-binding', 'session-remove', 'persistent-cleanup', '1'));
  await assertCode(kernel.stop('persistent-binding'), 'cleanup_failed');
  await assertCode(kernel.retry('persistent-binding'), 'cleanup_failed');
  assert.equal(kernel.inspect('persistent-binding').pendingCleanupEffects, 1);
  await kernel.retry('persistent-binding');
  assert.equal(kernel.inspect('persistent-binding').status, 'active');
});

test('system: installed revisions and composition remain deterministically ordered', async () => {
  const kernel = new ExtensionLifecycleKernel();
  for (const [extensionId, revision] of [
    ['zeta', '2'],
    ['alpha', '1'],
    ['zeta', '1'],
  ] as const) {
    await kernel.install(valueRevision(extensionId, revision, revision, []));
  }
  assert.deepEqual(kernel.installedRevisions(), [
    { extensionId: 'alpha', revision: '1' },
    { extensionId: 'zeta', revision: '1' },
    { extensionId: 'zeta', revision: '2' },
  ]);
  await kernel.activate(binding('zeta-binding', 'session-order', 'zeta', '2'));
  const before = kernel.composition('session-order');
  await kernel.stop('zeta-binding');
  await kernel.start('zeta-binding');
  const after = kernel.composition('session-order');
  assert.equal(before.digest, after.digest, 'generation changes do not alter composition identity');
  assert.notEqual(before.entries[0]?.generation, after.entries[0]?.generation);
});

test('system: 2,000 deterministic lifecycle operations preserve composition and resource invariants', async () => {
  const kernel = new ExtensionLifecycleKernel();
  const scopes = ['soak-a', 'soak-b', 'soak-c', 'soak-d'];
  const extensions = ['alpha', 'beta', 'gamma'] as const;
  const dependencies: Record<(typeof extensions)[number], readonly string[]> = {
    alpha: [],
    beta: ['alpha'],
    gamma: ['beta'],
  };
  const liveByBinding = new Map<string, number>();

  for (const extensionId of extensions) {
    for (const revision of ['1', '2']) {
      await kernel.install({
        extensionId,
        revision,
        dependencies: dependencies[extensionId].map((dependency) => ({ extensionId: dependency })),
        contributions: [{ id: `${extensionId}.service`, kind: 'service' }],
        prepare: () => ({
          activate: (context) => {
            const current = liveByBinding.get(context.bindingId) ?? 0;
            liveByBinding.set(context.bindingId, current + 1);
            context.ownEffect('resource', async () => {
              await Promise.resolve();
              liveByBinding.set(context.bindingId, liveByBinding.get(context.bindingId)! - 1);
            });
            return { value: `${context.scopeId}:${extensionId}:${revision}` };
          },
        }),
      });
    }
  }

  const random = seededRandom(0x2973);
  for (let step = 0; step < 2_000; step += 1) {
    const scope = scopes[Math.floor(random() * scopes.length)]!;
    const extensionId = extensions[Math.floor(random() * extensions.length)]!;
    const revision = random() < 0.5 ? '1' : '2';
    const bindingId = `${scope}-${extensionId}`;
    const existing = kernel.inspectScope(scope).find((item) => item.bindingId === bindingId);
    switch (Math.floor(random() * 6)) {
      case 0:
        await kernel.activate(binding(bindingId, scope, extensionId, revision));
        break;
      case 1:
        if (existing) await kernel.update(bindingId, revision);
        break;
      case 2:
        if (existing) await kernel.stop(bindingId);
        break;
      case 3:
        if (existing) await kernel.start(bindingId);
        break;
      case 4:
        if (existing) await kernel.removeBinding(bindingId);
        break;
      default:
        await kernel.disposeScope(scope);
    }
    if (step % 25 === 0) assertKernelInvariants(kernel, scopes, liveByBinding);
  }

  assertKernelInvariants(kernel, scopes, liveByBinding);
  for (const scope of scopes) await kernel.disposeScope(scope);
  assert.equal(
    [...liveByBinding.values()].reduce((sum, count) => sum + count, 0),
    0,
  );
});

interface TcpEndpoint {
  readonly port: number;
  readonly instance: number;
}

function tcpProviderRevision(
  extensionId: string,
  revision: string,
  ports: number[],
  events: string[],
): ExtensionRevisionDefinition {
  let instance = 0;
  return {
    extensionId,
    revision,
    prepare: async (context) => {
      instance += 1;
      const currentInstance = instance;
      const server = createServer((socket) => {
        socket.once('data', (data) => {
          const requestBody = data.toString();
          if (requestBody === 'health') socket.end(`healthy:${revision}:${currentInstance}`);
          else socket.write(`pong:${revision}:${currentInstance}`);
        });
      });
      await listen(server);
      const address = server.address();
      assert.ok(address && typeof address === 'object');
      ports.push(address.port);
      context.ownEffect('tcp-server', async () => {
        await closeServer(server);
        events.push(`provider:${currentInstance}:close`);
      });
      return {
        healthCheck: async () => {
          assert.equal(
            await request(address.port, 'health'),
            `healthy:${revision}:${currentInstance}`,
          );
        },
        activate: () => ({ value: { port: address.port, instance: currentInstance } }),
      };
    },
  };
}

function valueRevision(
  extensionId: string,
  revision: string,
  value: string,
  events: string[],
): ExtensionRevisionDefinition {
  return {
    extensionId,
    revision,
    prepare: () => ({
      activate: (context) => {
        events.push(`${extensionId}:${revision}:activate`);
        context.ownEffect(extensionId, () => {
          events.push(`${extensionId}:${revision}:dispose`);
        });
        return { value };
      },
    }),
  };
}

function derivedRevision(
  extensionId: string,
  dependencyIds: string[],
  events: string[],
): ExtensionRevisionDefinition {
  return {
    extensionId,
    revision: '1',
    dependencies: dependencyIds.map((dependency) => ({ extensionId: dependency })),
    prepare: () => ({
      activate: (context) => {
        const derived = dependencyIds
          .map(
            (dependency) =>
              `${context.dependency<string>(dependency)}@${context.dependencyRevision(dependency)}`,
          )
          .join('+');
        events.push(`${extensionId}:activate:${derived}`);
        context.ownEffect(extensionId, () => {
          events.push(`${extensionId}:dispose`);
        });
        return { value: `${extensionId}(${derived})` };
      },
    }),
  };
}

function assertKernelInvariants(
  kernel: ExtensionLifecycleKernel,
  scopes: string[],
  liveByBinding: ReadonlyMap<string, number>,
): void {
  let composedResources = 0;
  for (const scope of scopes) {
    const inspections = kernel.inspectScope(scope);
    const composition = kernel.composition(scope);
    assert.ok(Object.isFrozen(inspections));
    assert.ok(Object.isFrozen(composition));
    assert.ok(Object.isFrozen(composition.entries));
    assert.equal(kernel.composition(scope).digest, composition.digest);
    assert.deepEqual(
      inspections.map((item) => item.bindingId),
      [...inspections.map((item) => item.bindingId)].sort(),
    );
    assert.equal(new Set(inspections.map((item) => item.extensionId)).size, inspections.length);
    assert.equal(
      new Set(composition.entries.map((item) => item.extensionId)).size,
      composition.entries.length,
    );
    for (const entry of composition.entries) {
      const inspection = inspections.find((item) => item.bindingId === entry.bindingId);
      assert.equal(inspection?.current?.revision, entry.revision);
      assert.equal(liveByBinding.get(entry.bindingId), 1);
      composedResources += 1;
    }
    for (const inspection of inspections) {
      if (!inspection.current) assert.equal(liveByBinding.get(inspection.bindingId) ?? 0, 0);
      assert.ok(inspection.pendingCleanupEffects >= 0);
    }
  }
  assert.equal(
    [...liveByBinding.values()].reduce((sum, count) => sum + count, 0),
    composedResources,
  );
}

function binding(bindingId: string, scopeId: string, extensionId: string, revision: string) {
  return { bindingId, scopeId, extensionId, revision };
}

async function assertCode(promise: Promise<unknown>, code: ExtensionLifecycleErrorCode) {
  await assert.rejects(promise, hasCode(code));
}

function hasCode(code: ExtensionLifecycleErrorCode) {
  return (error: unknown) =>
    error instanceof ExtensionLifecycleOperationError && error.code === code;
}

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

async function listen(server: Server): Promise<void> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  server.close();
  await once(server, 'close');
}

async function destroySocket(socket: Socket): Promise<void> {
  if (socket.destroyed) return;
  socket.destroy();
  await once(socket, 'close');
}

async function request(port: number, body: string): Promise<string> {
  const socket = createConnection({ host: '127.0.0.1', port });
  socket.setTimeout(1_000, () => socket.destroy(new Error('request timeout')));
  await once(socket, 'connect');
  socket.end(body);
  return nextData(socket);
}

async function nextData(socket: Socket): Promise<string> {
  const [data] = (await once(socket, 'data')) as [Buffer];
  return data.toString();
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('condition timed out');
    await delay(2);
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
