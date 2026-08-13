import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  ExtensionLifecycleKernel,
  ExtensionLifecycleOperationError,
  type ExtensionRevisionDefinition,
} from '../extension-lifecycle-kernel.js';

test('install is effect-free and snapshots immutable revision metadata', async () => {
  const kernel = new ExtensionLifecycleKernel();
  const contributions = [{ id: 'alpha.fake', kind: 'fake' }];
  let prepares = 0;

  await kernel.install({
    extensionId: 'alpha',
    revision: '1',
    contributions,
    prepare: () => {
      prepares += 1;
      return { activate: () => undefined };
    },
  });
  contributions.push({ id: 'mutated.after.install', kind: 'fake' });

  assert.equal(prepares, 0, 'install must not execute extension code');
  assert.deepEqual(kernel.installedRevisions(), [{ extensionId: 'alpha', revision: '1' }]);
  await assertCode(
    kernel.install({
      extensionId: 'alpha',
      revision: '1',
      prepare: () => ({ activate: () => undefined }),
    }),
    'revision_already_installed',
  );

  await kernel.activate(binding('alpha-binding', 'session-a', 'alpha', '1'));
  assert.equal(prepares, 1);
  const snapshot = kernel.composition('session-a');
  assert.equal(snapshot.entries.length, 1);
  assert.deepEqual(snapshot.entries[0]!.contributions, [{ id: 'alpha.fake', kind: 'fake' }]);
  assert.ok(Object.isFrozen(snapshot));
  assert.ok(Object.isFrozen(snapshot.entries));
  assert.ok(Object.isFrozen(snapshot.entries[0]!.contributions));
});

test('stop disposes activation and preparation effects in reverse ownership order', async () => {
  const kernel = new ExtensionLifecycleKernel();
  const events: string[] = [];
  await kernel.install({
    extensionId: 'ordered',
    revision: '1',
    prepare: (context) => {
      context.ownEffect('prepare-effect', () => {
        events.push('prepare-effect');
      });
      return {
        dispose: () => {
          events.push('prepared-dispose');
        },
        activate: (activation) => {
          activation.ownEffect('first', () => {
            events.push('first');
          });
          activation.ownEffect('second', async () => {
            await Promise.resolve();
            events.push('second');
          });
        },
      };
    },
  });

  await kernel.activate(binding('ordered-binding', 'session-a', 'ordered', '1'));
  await kernel.stop('ordered-binding');

  assert.deepEqual(events, ['second', 'first', 'prepared-dispose', 'prepare-effect']);
  assert.equal(kernel.inspect('ordered-binding').status, 'stopped');
});

test('failed activation rolls back every candidate-owned effect', async () => {
  const kernel = new ExtensionLifecycleKernel();
  const events: string[] = [];
  await kernel.install({
    extensionId: 'broken',
    revision: '1',
    prepare: (context) => {
      context.ownEffect('prepare-effect', () => {
        events.push('prepare-effect');
      });
      return {
        dispose: () => {
          events.push('prepared-dispose');
        },
        activate: (activation) => {
          activation.ownEffect('published-effect', () => {
            events.push('published-effect');
          });
          throw new Error('boom');
        },
      };
    },
  });

  await assertCode(
    kernel.activate(binding('broken-binding', 'session-a', 'broken', '1')),
    'activation_failed',
  );
  assert.deepEqual(events, ['published-effect', 'prepared-dispose', 'prepare-effect']);
  assert.deepEqual(kernel.inspect('broken-binding'), {
    bindingId: 'broken-binding',
    scopeId: 'session-a',
    extensionId: 'broken',
    desiredRevision: '1',
    enabled: true,
    status: 'failed',
    waitingFor: [],
    pendingCleanupEffects: 0,
    diagnostic: {
      code: 'activation_failed',
      message: 'Extension candidate broken@1 activation failed',
      revision: '1',
      at: kernel.inspect('broken-binding').diagnostic!.at,
    },
  });
});

test('health-check failure never publishes the candidate', async () => {
  const kernel = new ExtensionLifecycleKernel();
  const events: string[] = [];
  await kernel.install({
    extensionId: 'unhealthy',
    revision: '1',
    prepare: () => ({
      healthCheck: () => {
        events.push('health');
        throw new Error('not ready');
      },
      activate: () => {
        events.push('activate');
      },
      dispose: () => {
        events.push('dispose');
      },
    }),
  });

  await assertCode(
    kernel.activate(binding('unhealthy-binding', 'session-a', 'unhealthy', '1')),
    'health_check_failed',
  );
  assert.deepEqual(events, ['health', 'dispose']);
  assert.equal(kernel.composition('session-a').entries.length, 0);
});

test('dependencies wait, inject the active value, stop dependents first, and recover', async () => {
  const kernel = new ExtensionLifecycleKernel();
  const events: string[] = [];
  const seen: string[] = [];
  await kernel.install(
    lifecycleRevision('provider', '1', events, {
      value: 'provider-value',
    }),
  );
  await kernel.install({
    extensionId: 'consumer',
    revision: '1',
    dependencies: [{ extensionId: 'provider' }],
    prepare: () => ({
      activate: (context) => {
        seen.push(
          `${context.dependency<string>('provider')}@${context.dependencyRevision('provider')}`,
        );
        context.ownEffect('consumer', () => {
          events.push('consumer:dispose');
        });
      },
    }),
  });

  const waiting = await kernel.activate(binding('b-consumer', 'session-a', 'consumer', '1'));
  assert.equal(waiting.status, 'waiting');
  assert.deepEqual(waiting.waitingFor, ['provider']);

  await kernel.activate(binding('a-provider', 'session-a', 'provider', '1'));
  assert.equal(kernel.inspect('b-consumer').status, 'active');
  assert.deepEqual(seen, ['provider-value@1']);

  events.length = 0;
  await kernel.stop('a-provider');
  assert.deepEqual(events, ['consumer:dispose', 'provider:1:dispose']);
  assert.equal(kernel.inspect('b-consumer').status, 'waiting');
  assert.deepEqual(kernel.inspect('b-consumer').waitingFor, ['provider']);

  await kernel.start('a-provider');
  assert.equal(kernel.inspect('b-consumer').status, 'active');
  assert.deepEqual(seen, ['provider-value@1', 'provider-value@1']);
});

test('successful update keeps current during prepare and commits a new immutable composition', async () => {
  const kernel = new ExtensionLifecycleKernel();
  const events: string[] = [];
  const gate = deferred<void>();
  const prepareStarted = deferred<void>();
  await kernel.install(lifecycleRevision('updatable', '1', events));
  await kernel.install({
    extensionId: 'updatable',
    revision: '2',
    contributions: [{ id: 'new.fake', kind: 'fake' }],
    prepare: async () => {
      prepareStarted.resolve();
      await gate.promise;
      return {
        activate: (context) => {
          events.push('updatable:2:activate');
          context.ownEffect('v2', () => {
            events.push('updatable:2:dispose');
          });
        },
      };
    },
  });
  await kernel.activate(binding('updatable-binding', 'session-a', 'updatable', '1'));
  const before = kernel.composition('session-a');

  const update = kernel.update('updatable-binding', '2');
  await prepareStarted.promise;
  const during = kernel.inspect('updatable-binding');
  assert.equal(during.current?.revision, '1');
  assert.deepEqual(during.candidate, { revision: '2', phase: 'preparing' });
  assert.equal(before.entries[0]!.revision, '1');

  gate.resolve();
  const updated = await update;
  assert.equal(updated.current?.revision, '2');
  assert.equal(updated.status, 'active');
  assert.deepEqual(events.slice(-2), ['updatable:2:activate', 'updatable:1:dispose']);
  const after = kernel.composition('session-a');
  assert.equal(before.entries[0]!.revision, '1', 'old snapshot remains immutable');
  assert.equal(after.entries[0]!.revision, '2');
  assert.notEqual(before.digest, after.digest);
});

test('failed candidate health check preserves the committed activation', async () => {
  const kernel = new ExtensionLifecycleKernel();
  const events: string[] = [];
  await kernel.install(lifecycleRevision('safe-update', '1', events));
  await kernel.install({
    extensionId: 'safe-update',
    revision: '2',
    prepare: (context) => {
      context.ownEffect('candidate-prepare', () => {
        events.push('candidate-prepare:dispose');
      });
      return {
        healthCheck: () => {
          throw new Error('candidate unhealthy');
        },
        activate: () => {
          events.push('candidate:activate');
        },
      };
    },
  });
  await kernel.activate(binding('safe-binding', 'session-a', 'safe-update', '1'));

  await assertCode(kernel.update('safe-binding', '2'), 'health_check_failed');
  const inspection = kernel.inspect('safe-binding');
  assert.equal(inspection.current?.revision, '1');
  assert.equal(inspection.status, 'active');
  assert.equal(inspection.diagnostic?.code, 'health_check_failed');
  assert.deepEqual(events, ['safe-update:1:activate', 'candidate-prepare:dispose']);
});

test('failed provider activation restores dependents against the old current', async () => {
  const kernel = new ExtensionLifecycleKernel();
  const events: string[] = [];
  const seen: string[] = [];
  await kernel.install(lifecycleRevision('provider', '1', events, { value: 'old' }));
  await kernel.install({
    extensionId: 'provider',
    revision: '2',
    prepare: () => ({
      activate: (context) => {
        events.push('provider:2:activate');
        context.ownEffect('provider-v2', () => {
          events.push('provider:2:dispose');
        });
        throw new Error('candidate failed');
      },
    }),
  });
  await kernel.install({
    extensionId: 'consumer',
    revision: '1',
    dependencies: [{ extensionId: 'provider' }],
    prepare: () => ({
      activate: (context) => {
        seen.push(context.dependency<string>('provider'));
        context.ownEffect('consumer', () => {
          events.push('consumer:dispose');
        });
      },
    }),
  });
  await kernel.activate(binding('a-provider', 'session-a', 'provider', '1'));
  await kernel.activate(binding('b-consumer', 'session-a', 'consumer', '1'));

  await assertCode(kernel.update('a-provider', '2'), 'activation_failed');
  assert.equal(kernel.inspect('a-provider').current?.revision, '1');
  assert.equal(kernel.inspect('b-consumer').status, 'active');
  assert.deepEqual(seen, ['old', 'old']);
  assert.deepEqual(events.slice(-3), [
    'consumer:dispose',
    'provider:2:activate',
    'provider:2:dispose',
  ]);
});

test('dependency cycles are diagnosed without executing extension code', async () => {
  const kernel = new ExtensionLifecycleKernel();
  let activations = 0;
  await kernel.install({
    extensionId: 'cycle-a',
    revision: '1',
    dependencies: [{ extensionId: 'cycle-b' }],
    prepare: () => ({ activate: () => void (activations += 1) }),
  });
  await kernel.install({
    extensionId: 'cycle-b',
    revision: '1',
    dependencies: [{ extensionId: 'cycle-a' }],
    prepare: () => ({ activate: () => void (activations += 1) }),
  });

  const first = await kernel.activate(binding('cycle-a-binding', 'session-a', 'cycle-a', '1'));
  assert.equal(first.status, 'waiting');
  await assertCode(
    kernel.activate(binding('cycle-b-binding', 'session-a', 'cycle-b', '1')),
    'dependency_cycle',
  );
  assert.equal(kernel.inspect('cycle-a-binding').diagnostic?.code, 'dependency_cycle');
  assert.equal(kernel.inspect('cycle-b-binding').diagnostic?.code, 'dependency_cycle');
  assert.equal(activations, 0);
});

test('dependency resolution and stop are isolated by scope', async () => {
  const kernel = new ExtensionLifecycleKernel();
  const events: string[] = [];
  const seen: string[] = [];
  await kernel.install(lifecycleRevision('provider', '1', events, { value: 'scoped' }));
  await kernel.install({
    extensionId: 'consumer',
    revision: '1',
    dependencies: [{ extensionId: 'provider' }],
    prepare: () => ({
      activate: (context) => {
        seen.push(`${context.scopeId}:${context.dependency<string>('provider')}`);
        context.ownEffect('consumer', () => undefined);
      },
    }),
  });
  for (const scope of ['session-a', 'session-b']) {
    await kernel.activate(binding(`${scope}-provider`, scope, 'provider', '1'));
    await kernel.activate(binding(`${scope}-consumer`, scope, 'consumer', '1'));
  }

  await kernel.stop('session-a-provider');
  assert.equal(kernel.inspect('session-a-consumer').status, 'waiting');
  assert.equal(kernel.inspect('session-b-consumer').status, 'active');
  assert.equal(kernel.composition('session-a').entries.length, 0);
  assert.equal(kernel.composition('session-b').entries.length, 2);
  assert.deepEqual(seen, ['session-a:scoped', 'session-b:scoped']);
});

test('uninstall requires all bindings to release the immutable revision', async () => {
  const kernel = new ExtensionLifecycleKernel();
  await kernel.install({
    extensionId: 'removable',
    revision: '1',
    prepare: () => ({ activate: () => undefined }),
  });
  await kernel.activate(binding('removable-binding', 'session-a', 'removable', '1'));
  await assertCode(kernel.uninstall('removable', '1'), 'revision_in_use');
  await kernel.stop('removable-binding');
  await assertCode(kernel.uninstall('removable', '1'), 'revision_in_use');
  await kernel.removeBinding('removable-binding');
  await kernel.uninstall('removable', '1');
  assert.deepEqual(kernel.installedRevisions(), []);
});

test('concurrent mutations serialize update before a later stop', async () => {
  const kernel = new ExtensionLifecycleKernel();
  const events: string[] = [];
  const gate = deferred<void>();
  const started = deferred<void>();
  await kernel.install(lifecycleRevision('serialized', '1', events));
  await kernel.install({
    extensionId: 'serialized',
    revision: '2',
    prepare: async () => {
      started.resolve();
      await gate.promise;
      return {
        activate: (context) => {
          events.push('serialized:2:activate');
          context.ownEffect('v2', () => {
            events.push('serialized:2:dispose');
          });
        },
      };
    },
  });
  await kernel.activate(binding('serialized-binding', 'session-a', 'serialized', '1'));

  const update = kernel.update('serialized-binding', '2');
  await started.promise;
  const stop = kernel.stop('serialized-binding');
  assert.equal(kernel.inspect('serialized-binding').candidate?.revision, '2');
  gate.resolve();
  await update;
  await stop;

  assert.equal(kernel.inspect('serialized-binding').status, 'stopped');
  assert.deepEqual(events.slice(-3), [
    'serialized:2:activate',
    'serialized:1:dispose',
    'serialized:2:dispose',
  ]);
});

test('failed cleanup remains diagnosable and can be retried', async () => {
  const kernel = new ExtensionLifecycleKernel();
  let attempts = 0;
  await kernel.install({
    extensionId: 'cleanup-retry',
    revision: '1',
    prepare: () => ({
      activate: (context) => {
        context.ownEffect('flaky', () => {
          attempts += 1;
          if (attempts === 1) throw new Error('temporary cleanup failure');
        });
      },
    }),
  });
  await kernel.activate(binding('cleanup-binding', 'session-a', 'cleanup-retry', '1'));

  await assertCode(kernel.stop('cleanup-binding'), 'cleanup_failed');
  const failed = kernel.inspect('cleanup-binding');
  assert.equal(failed.status, 'failed');
  assert.equal(failed.pendingCleanupEffects, 1);
  assert.equal(failed.diagnostic?.code, 'cleanup_failed');

  const stopped = await kernel.stop('cleanup-binding');
  assert.equal(stopped.status, 'stopped');
  assert.equal(stopped.pendingCleanupEffects, 0);
  assert.equal(attempts, 2);
});

test('an update waits for new dependencies without disturbing current', async () => {
  const kernel = new ExtensionLifecycleKernel();
  const events: string[] = [];
  await kernel.install(lifecycleRevision('switchable', '1', events));
  await kernel.install({
    extensionId: 'switchable',
    revision: '2',
    dependencies: [{ extensionId: 'provider' }],
    prepare: () => ({
      activate: (context) => {
        events.push(`switchable:2:${context.dependency<string>('provider')}`);
        context.ownEffect('switchable-v2', () => undefined);
      },
    }),
  });
  await kernel.install(lifecycleRevision('provider', '1', events, { value: 'ready' }));
  await kernel.activate(binding('switchable-binding', 'session-a', 'switchable', '1'));

  const waiting = await kernel.update('switchable-binding', '2');
  assert.equal(waiting.status, 'waiting');
  assert.equal(waiting.current?.revision, '1');
  assert.equal(waiting.desiredRevision, '2');
  assert.deepEqual(waiting.waitingFor, ['provider']);

  await kernel.activate(binding('provider-binding', 'session-a', 'provider', '1'));
  assert.equal(kernel.inspect('switchable-binding').current?.revision, '2');
  assert.ok(events.includes('switchable:2:ready'));
});

test('candidate commit remains authoritative when retired-current cleanup needs retry', async () => {
  const kernel = new ExtensionLifecycleKernel();
  let oldCleanupAttempts = 0;
  await kernel.install({
    extensionId: 'retired-cleanup',
    revision: '1',
    prepare: () => ({
      activate: (context) => {
        context.ownEffect('old', () => {
          oldCleanupAttempts += 1;
          if (oldCleanupAttempts === 1) throw new Error('old cleanup failed');
        });
      },
    }),
  });
  await kernel.install({
    extensionId: 'retired-cleanup',
    revision: '2',
    prepare: () => ({
      activate: (context) => context.ownEffect('new', () => undefined),
    }),
  });
  await kernel.activate(binding('retired-binding', 'session-a', 'retired-cleanup', '1'));

  await assertCode(kernel.update('retired-binding', '2'), 'cleanup_failed');
  const committed = kernel.inspect('retired-binding');
  assert.equal(committed.current?.revision, '2');
  assert.equal(committed.pendingCleanupEffects, 1);
  assert.equal(committed.diagnostic?.code, 'cleanup_failed');

  const recovered = await kernel.start('retired-binding');
  assert.equal(recovered.current?.revision, '2');
  assert.equal(recovered.pendingCleanupEffects, 0);
  assert.equal(oldCleanupAttempts, 2);
});

test('disposing a scope retracts dependents before providers and removes every binding', async () => {
  const kernel = new ExtensionLifecycleKernel();
  const events: string[] = [];
  await kernel.install(lifecycleRevision('provider', '1', events));
  await kernel.install({
    extensionId: 'consumer',
    revision: '1',
    dependencies: [{ extensionId: 'provider' }],
    prepare: () => ({
      activate: (context) => {
        events.push('consumer:activate');
        context.ownEffect('consumer', () => {
          events.push('consumer:dispose');
        });
      },
    }),
  });
  await kernel.activate(binding('provider-binding', 'session-a', 'provider', '1'));
  await kernel.activate(binding('consumer-binding', 'session-a', 'consumer', '1'));
  events.length = 0;

  await kernel.disposeScope('session-a');
  assert.deepEqual(events, ['consumer:dispose', 'provider:1:dispose']);
  assert.deepEqual(kernel.inspectScope('session-a'), []);
  assert.deepEqual(kernel.composition('session-a').entries, []);
});

function binding(bindingId: string, scopeId: string, extensionId: string, revision: string) {
  return { bindingId, scopeId, extensionId, revision };
}

function lifecycleRevision(
  extensionId: string,
  revision: string,
  events: string[],
  options: { value?: unknown } = {},
): ExtensionRevisionDefinition {
  return {
    extensionId,
    revision,
    prepare: () => ({
      activate: (context) => {
        events.push(`${extensionId}:${revision}:activate`);
        context.ownEffect(`${extensionId}:${revision}`, () => {
          events.push(`${extensionId}:${revision}:dispose`);
        });
        return { value: options.value };
      },
    }),
  };
}

async function assertCode(
  promise: Promise<unknown>,
  code: ExtensionLifecycleOperationError['code'],
): Promise<void> {
  await assert.rejects(
    promise,
    (error) => error instanceof ExtensionLifecycleOperationError && error.code === code,
  );
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
