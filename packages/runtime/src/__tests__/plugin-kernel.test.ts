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
import test from 'node:test';
import { Context, FiberState, Service, type Plugin } from '../plugin-kernel.js';
import { registerPluginContribution } from '../plugin-runtime.js';

declare module '../plugin-kernel.js' {
  interface Context {
    fixture?: { readonly value: string };
  }
}

test('injected plugins wait for Services and reload when ownership changes', async () => {
  const root = new Context();
  const lifecycle: string[] = [];
  const consumer = Object.assign(
    (ctx: Context) => {
      const value = ctx.fixture?.value;
      lifecycle.push(`load:${value}`);
      return () => lifecycle.push(`dispose:${value}`);
    },
    { inject: ['fixture'] },
  ) satisfies Plugin;

  const fiber = root.plugin(consumer);
  await fiber.await();
  assert.equal(fiber.state, FiberState.PENDING);

  const removeFirst = root.provide('fixture', { value: 'first' });
  await fiber.await();
  assert.equal(fiber.state, FiberState.ACTIVE);
  assert.deepEqual(lifecycle, ['load:first']);

  await removeFirst();
  await fiber.await();
  assert.equal(fiber.state, FiberState.PENDING);
  assert.deepEqual(lifecycle, ['load:first', 'dispose:first']);

  root.provide('fixture', { value: 'second' });
  await fiber.await();
  assert.equal(fiber.state, FiberState.ACTIVE);
  assert.deepEqual(lifecycle, ['load:first', 'dispose:first', 'load:second']);
  await root.fiber.dispose();
});

test('Services provided by a plugin activate dependent plugins after the provider is active', async () => {
  const root = new Context();
  let consumed: string | undefined;
  const consumer = Object.assign(
    (ctx: Context) => {
      consumed = ctx.get<{ readonly value: string }>('pluginService')?.value;
    },
    { inject: ['pluginService'] },
  );
  const consumerFiber = root.plugin(consumer);
  await consumerFiber.await();
  assert.equal(consumerFiber.state, FiberState.PENDING);

  const providerFiber = root.plugin((ctx) => {
    ctx.provide('pluginService', { value: 'ready' });
  });
  await providerFiber.await();
  await consumerFiber.await();

  assert.equal(providerFiber.state, FiberState.ACTIVE);
  assert.equal(consumerFiber.state, FiberState.ACTIVE);
  assert.equal(consumed, 'ready');
  await root.fiber.dispose();
});

test('Service health-check failures move consumers to failed and allow recovery', async () => {
  const root = new Context();
  let healthy = true;
  let activations = 0;
  root.provide('checkedService', { value: 1 }, () => {
    if (!healthy) throw new Error('Service health check failed');
    return true;
  });
  const consumer = root.plugin(
    Object.assign(
      () => {
        activations += 1;
      },
      { inject: ['checkedService'] },
    ),
  );
  await consumer.await();
  assert.equal(consumer.state, FiberState.ACTIVE);

  healthy = false;
  root.set('checkedService', { value: 2 });
  await assert.rejects(consumer.await(), /Service health check failed/u);
  assert.equal(consumer.state, FiberState.FAILED);

  healthy = true;
  root.set('checkedService', { value: 3 });
  await consumer.await();
  assert.equal(consumer.state, FiberState.ACTIVE);
  assert.equal(activations, 2);
  await root.fiber.dispose();
});

test('a provider with multiple Services activates each dependent Fiber once', async () => {
  const root = new Context();
  let activations = 0;
  const consumer = root.plugin(
    Object.assign(
      () => {
        activations += 1;
      },
      { inject: ['firstService', 'secondService'] },
    ),
  );
  await consumer.await();

  const provider = root.plugin((ctx) => {
    ctx.provide('firstService', { value: 1 });
    ctx.provide('secondService', { value: 2 });
  });
  await provider.await();
  await consumer.await();

  assert.equal(provider.state, FiberState.ACTIVE);
  assert.equal(consumer.state, FiberState.ACTIVE);
  assert.equal(activations, 1);
  await root.fiber.dispose();
});

test('rapid Service updates coalesce dependent Fiber reloads around the latest value', async () => {
  const root = new Context();
  root.provide('fixture', { value: 1 });
  const activations: number[] = [];
  const consumer = root.plugin(
    Object.assign(
      (ctx: Context) => {
        activations.push(ctx.get<{ readonly value: number }>('fixture')!.value);
      },
      { inject: ['fixture'] },
    ),
  );
  await consumer.await();

  root.set('fixture', { value: 2 });
  root.set('fixture', { value: 3 });
  await consumer.await();

  assert.deepEqual(activations, [1, 3]);
  await root.fiber.dispose();
});

test('Fiber await includes a Service refresh queued during activation', async () => {
  const root = new Context();
  root.provide('fixture', { value: 1 });
  const activations: number[] = [];
  let releaseFirst!: () => void;
  let releaseSecond!: () => void;
  let signalFirst!: () => void;
  let signalSecond!: () => void;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const secondGate = new Promise<void>((resolve) => {
    releaseSecond = resolve;
  });
  const firstStarted = new Promise<void>((resolve) => {
    signalFirst = resolve;
  });
  const secondStarted = new Promise<void>((resolve) => {
    signalSecond = resolve;
  });
  const consumer = root.plugin(
    Object.assign(
      async (ctx: Context) => {
        const value = ctx.get<{ readonly value: number }>('fixture')!.value;
        activations.push(value);
        if (value === 1) {
          signalFirst();
          await firstGate;
        } else {
          signalSecond();
          await secondGate;
        }
      },
      { inject: ['fixture'] },
    ),
  );

  await firstStarted;
  const settled = consumer.await();
  root.set('fixture', { value: 2 });
  releaseFirst();
  await secondStarted;

  let completed = false;
  void settled.then(() => {
    completed = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(completed, false);

  releaseSecond();
  await settled;
  assert.equal(consumer.state, FiberState.ACTIVE);
  assert.deepEqual(activations, [1, 2]);
  await root.fiber.dispose();
});

test('Fiber await observes the final state after an intermediate transition rejects', async () => {
  const root = new Context();
  const fiber = root.plugin((_ctx, config: string) => {
    if (config === 'broken') throw new Error('broken transition');
  }, 'initial');
  await fiber.await();

  const broken = fiber.update('broken');
  const recovered = fiber.update('recovered');
  await fiber.await();

  await assert.rejects(broken, /broken transition/u);
  await recovered;
  assert.equal(fiber.state, FiberState.ACTIVE);
  assert.equal(fiber.config, 'recovered');
  await root.fiber.dispose();
});

test('fire-and-forget Fiber activation failures do not become unhandled rejections', async () => {
  const root = new Context();
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  try {
    const fiber = root.plugin(() => {
      throw new Error('activation failed');
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.deepEqual(unhandled, []);
    await assert.rejects(fiber.await(), /activation failed/u);
  } finally {
    process.off('unhandledRejection', onUnhandled);
    await root.fiber.dispose().catch(() => undefined);
  }
});

test('asynchronous Effect setup and cleanup failures are observed internally', async () => {
  const root = new Context();
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  try {
    const fiber = root.plugin((ctx) => {
      ctx.effect(async function* () {
        yield () => {
          throw new Error('effect cleanup failed');
        };
        throw new Error('effect setup failed');
      }, 'failed-async-effect');
    });
    await fiber.await();
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.deepEqual(unhandled, []);
    assert.ok(fiber.error instanceof AggregateError);
  } finally {
    process.off('unhandledRejection', onUnhandled);
    await root.fiber.dispose().catch(() => undefined);
  }
});

test('synchronous Effect setup failures preserve the active Fiber contract', async () => {
  const root = new Context();
  const fiber = root.plugin((ctx) => {
    ctx.effect(() => {
      throw new Error('synchronous effect setup failed');
    }, 'failed-sync-effect');
  });

  await fiber.await();
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(fiber.state, FiberState.ACTIVE);
  assert.match(String(fiber.error), /synchronous effect setup failed/u);
  await root.fiber.dispose();
});

test('Service isolation keeps sibling implementations independent', async () => {
  const root = new Context();
  root.provide('fixture', { value: 'root' });
  const isolated = root.isolate('fixture');
  isolated.provide('fixture', { value: 'isolated' });

  assert.equal(root.get<{ value: string }>('fixture')?.value, 'root');
  assert.equal(isolated.get<{ value: string }>('fixture')?.value, 'isolated');
  assert.equal(root.extend().get<{ value: string }>('fixture')?.value, 'root');
  await root.fiber.dispose();
});

test('Fiber update preserves identity and disposes Effects in reverse order', async () => {
  const root = new Context();
  const lifecycle: string[] = [];
  const plugin = (ctx: Context, config: { value: number }) => {
    lifecycle.push(`load:${config.value}`);
    ctx.effect(() => () => lifecycle.push(`first:${config.value}`), 'first');
    ctx.effect(() => () => lifecycle.push(`second:${config.value}`), 'second');
  };
  const fiber = root.plugin(plugin, { value: 1 });
  await fiber.await();
  const id = fiber.id;

  await fiber.update({ value: 2 });
  assert.equal(fiber.id, id);
  assert.deepEqual(lifecycle, ['load:1', 'second:1', 'first:1', 'load:2']);
  assert.deepEqual(
    fiber.getEffects().map(({ label }) => label),
    ['first', 'second'],
  );
  await root.fiber.dispose();
});

test('Fiber Proxy exposes getters backed by private state', async () => {
  const root = new Context();
  const fiber = root.plugin({ name: 'named-plugin', apply: () => undefined });

  assert.equal(fiber.name, 'named-plugin');
  await fiber.await();
  await root.fiber.dispose();
});

test('Plugin objects sharing apply retain independent Runtime metadata', async () => {
  const root = new Context();
  const activations: string[] = [];
  const apply = (_ctx: Context, config: string) => {
    activations.push(config);
  };
  const plugin = (name: string, prefix: string): Plugin.Object => ({
    name,
    apply,
    Config: {
      '~standard': {
        validate: (value) => ({ value: `${prefix}:${String(value)}` }),
      },
    },
  });

  const first = root.plugin(plugin('first-plugin', 'first'), 'a');
  const second = root.plugin(plugin('second-plugin', 'second'), 'b');
  await Promise.all([first.await(), second.await()]);

  assert.equal(first.name, 'first-plugin');
  assert.equal(second.name, 'second-plugin');
  assert.deepEqual(activations, ['first:a', 'second:b']);
  await root.fiber.dispose();
});

test('Standard Schema validation preserves raw Fiber config across restarts', async () => {
  const root = new Context();
  const values: string[] = [];
  const plugin: Plugin.Object = {
    Config: {
      '~standard': {
        validate: (value) => ({ value: `parsed:${String(value)}` }),
      },
    },
    apply(_ctx, config) {
      values.push(String(config));
    },
  };
  const fiber = root.plugin(plugin, 'raw');
  await fiber.await();
  await fiber.restart();

  assert.equal(fiber.config, 'raw');
  assert.deepEqual(values, ['parsed:raw', 'parsed:raw']);
  await root.fiber.dispose();
});

test('Fiber update restores the previous active config after activation fails', async () => {
  const root = new Context();
  const lifecycle: string[] = [];
  const fiber = root.plugin(
    (_ctx, config: { value: number }) => {
      lifecycle.push(`load:${config.value}`);
      if (config.value === 2) throw new Error('invalid update');
      return () => lifecycle.push(`dispose:${config.value}`);
    },
    { value: 1 },
  );
  await fiber.await();

  await assert.rejects(fiber.update({ value: 2 }), /invalid update/u);

  assert.equal(fiber.state, FiberState.ACTIVE);
  assert.deepEqual(fiber.config, { value: 1 });
  assert.deepEqual(lifecycle, ['load:1', 'dispose:1', 'load:2', 'load:1']);
  await root.fiber.dispose();
});

test('concurrent Fiber updates serialize config activation and isolate rollback', async () => {
  const values: string[] = [];
  const root = new Context();
  const fiber = root.plugin((_ctx, config: string) => {
    values.push(config);
    if (config === 'broken') throw new Error('broken config');
  }, 'initial');
  await fiber.await();

  await Promise.all([fiber.update('first'), fiber.update('second')]);
  assert.deepEqual(values, ['initial', 'first', 'second']);
  assert.equal(fiber.config, 'second');

  const results = await Promise.allSettled([fiber.update('broken'), fiber.update('final')]);
  assert.equal(results[0]?.status, 'rejected');
  assert.equal(results[1]?.status, 'fulfilled');
  assert.deepEqual(values, ['initial', 'first', 'second', 'broken', 'second', 'final']);
  assert.equal(fiber.config, 'final');
  assert.equal(fiber.state, FiberState.ACTIVE);
  await fiber.dispose();
  await root.fiber.dispose();
});

test('Fiber cleanup exhausts Effects before reporting disposer failures', async () => {
  const root = new Context();
  const lifecycle: string[] = [];
  const fiber = root.plugin((ctx) => {
    ctx.effect(() => () => lifecycle.push('first'));
    ctx.effect(() => () => {
      lifecycle.push('failing');
      throw new Error('cleanup failed');
    });
    ctx.effect(() => () => lifecycle.push('last'));
  });
  await fiber.await();

  const firstDispose = fiber.dispose();
  const concurrentDispose = fiber.dispose();
  assert.equal(concurrentDispose, firstDispose);
  const firstError = await firstDispose.then(
    () => undefined,
    (error: unknown) => error,
  );
  assert.ok(firstError instanceof AggregateError);

  const retryDispose = fiber.dispose();
  assert.equal(retryDispose, firstDispose);
  const retryError = await retryDispose.then(
    () => undefined,
    (error: unknown) => error,
  );
  assert.equal(retryError, firstError);
  assert.deepEqual(lifecycle, ['last', 'failing', 'first']);
  assert.equal(fiber.state, FiberState.DISPOSED);
  assert.equal(root.kernelFibers().includes(fiber), false);
  await root.fiber.dispose();
});

test('Service loss preserves consumer cleanup failure on the owning Fiber', async () => {
  const root = new Context();
  const removeService = root.provide('fixture', { value: 'ready' });
  let activations = 0;
  const consumer = root.plugin(
    Object.assign(
      () => {
        activations += 1;
        return () => {
          throw new Error('cleanup boom');
        };
      },
      { inject: ['fixture'] },
    ),
  );
  await consumer.await();
  assert.equal(consumer.state, FiberState.ACTIVE);

  await removeService();

  assert.equal(consumer.state, FiberState.FAILED);
  const error = await consumer.await().then(
    () => undefined,
    (reason: unknown) => reason,
  );
  assert.ok(error instanceof AggregateError);
  const fiberCleanup = error.errors[0];
  assert.ok(fiberCleanup instanceof AggregateError);
  const effectCleanup = fiberCleanup.errors[0];
  assert.ok(effectCleanup instanceof AggregateError);
  assert.match(String(effectCleanup.errors[0]), /cleanup boom/u);

  root.provide('fixture', { value: 'replacement' });
  await assert.rejects(consumer.await(), AggregateError);
  assert.equal(consumer.state, FiberState.FAILED);
  assert.equal(activations, 1);
  await root.fiber.dispose();
});

test('Fiber owns derived Context views, child Fibers, and their Effects', async () => {
  const root = new Context();
  const lifecycle: string[] = [];
  let accountA!: Context;
  let accountB!: Context;
  let child!: ReturnType<Context['plugin']>;

  const owner = root.plugin((ctx) => {
    accountA = ctx.extend({ account: 'a' });
    accountB = ctx.extend({ account: 'b' });
    accountA.effect(() => () => lifecycle.push('account-a'), 'account-a');
    accountB.effect(() => () => lifecycle.push('account-b'), 'account-b');
    child = accountB.plugin(() => undefined);
  });
  await owner.await();
  await child.await();

  assert.equal(owner.context.fiber, owner);
  assert.equal(accountA.fiber, owner);
  assert.equal(accountB.fiber, owner);
  assert.equal(child.parent, owner);
  assert.throws(
    () => child.deriveContext(accountA),
    /Cannot derive a Context view from another Fiber/u,
  );
  assert.throws(
    () => child.mount(accountB, () => undefined),
    /Cannot mount a child through a Context owned by another Fiber/u,
  );
  assert.deepEqual(
    owner.getEffects().map(({ label }) => label),
    ['account-a', 'account-b'],
  );

  await owner.dispose();
  assert.equal(child.state, FiberState.DISPOSED);
  assert.deepEqual(lifecycle, ['account-b', 'account-a']);
  await root.fiber.dispose();
});

test('concurrent Effect disposal shares the same completion task', async () => {
  const root = new Context();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const dispose = root.effect(() => async () => gate, 'slow-cleanup');

  const first = dispose();
  const second = dispose();
  assert.equal(second, first);
  let completed = false;
  void second.then(() => {
    completed = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(completed, false);

  release();
  await first;
  assert.equal(completed, true);
  await root.fiber.dispose();
});

test('Plugin Runtime metadata cache uses weak Plugin identities', async () => {
  const root = new Context();
  assert.ok(root._kernel().runtimes instanceof WeakMap);
  await root.fiber.dispose();
});

test('accessors cannot shadow existing Context properties', async () => {
  const root = new Context();
  assert.throws(
    () => root.accessor('plugin', { get: () => 'hidden' }),
    /Context property already exists: plugin/u,
  );
  await root.fiber.dispose();
});

test('child accessors cannot shadow metadata inherited from parent Contexts', async () => {
  const root = new Context();
  const parent = root.extend({ inheritedMeta: 'visible' });
  const child = parent.extend();

  assert.throws(
    () => child.accessor('inheritedMeta', { get: () => 'hidden' }),
    /Context property already exists: inheritedMeta/u,
  );
  assert.equal(Reflect.get(child, 'inheritedMeta'), 'visible');
  await root.fiber.dispose();
});

test('Context metadata cannot replace Fiber ownership or environment topology', async () => {
  const root = new Context();

  for (const field of ['fiber', 'parent', 'root', 'logger']) {
    assert.throws(
      () => root.extend({ [field]: undefined }),
      new RegExp(`Context metadata cannot overwrite owned field: ${field}`, 'u'),
    );
  }

  const child = root.extend({ account: 'fixture' });
  assert.equal(child.fiber, root.fiber);
  assert.equal(child.parent, root);
  assert.equal(child.root, root);
  await root.fiber.dispose();
});

test('Services cannot shadow metadata inherited from parent Contexts', async () => {
  const root = new Context();
  root.provide('entryMetadata', { value: 'service' });
  const metadata = { value: 'metadata' };
  const child = root.extend({ entryMetadata: metadata }).extend();

  assert.equal(Reflect.get(child, 'entryMetadata'), metadata);
  assert.deepEqual(child.get('entryMetadata'), { value: 'service' });
  await root.fiber.dispose();
});

test('mixin validates every target before publishing accessors', async () => {
  const root = new Context();

  assert.throws(
    () => root.mixin({ first: 1, second: 2 }, { first: 'mixed', second: 'plugin' }),
    /Context property already exists: plugin/u,
  );
  assert.equal(root._kernel().accessors.has('mixed'), false);
  assert.equal(Reflect.get(root, 'mixed'), undefined);
  await root.fiber.dispose();
});

test('unknown Context property reads do not create Service labels', async () => {
  const root = new Context();
  const labels = root._kernel().serviceLabels;

  for (let index = 0; index < 100; index += 1) {
    assert.equal(Reflect.get(root, `unknownService${index}`), undefined);
  }
  assert.equal(labels.size, 0);

  const service = { value: 'available' };
  root.provide('futureService', service);
  assert.equal(Reflect.get(root, 'futureService'), service);
  assert.equal(labels.size, 1);
  await root.fiber.dispose();
});

test('event dispatch supports emit, parallel, serial, bail, and waterfall', async () => {
  const root = new Context();
  const emitted: string[] = [];
  root.on('emit', (value) => emitted.push(`one:${String(value)}`));
  root.on('emit', (value) => emitted.push(`two:${String(value)}`));
  root.emit('emit', 1);
  assert.deepEqual(emitted, ['one:1', 'two:1']);

  const parallel: string[] = [];
  root.on('parallel', async () => {
    await Promise.resolve();
    parallel.push('one');
  });
  root.on('parallel', () => parallel.push('two'));
  await root.parallel('parallel');
  assert.deepEqual(parallel.sort(), ['one', 'two']);

  const attempted: string[] = [];
  root.on('parallel-error', () => {
    attempted.push('throwing');
    throw new Error('synchronous listener failed');
  });
  root.on('parallel-error', () => attempted.push('following'));
  await assert.rejects(root.parallel('parallel-error'), AggregateError);
  assert.deepEqual(attempted, ['throwing', 'following']);

  root.on('serial', () => undefined);
  root.on('serial', () => 'stop');
  root.on('serial', () => 'unreachable');
  assert.equal(await root.serial('serial'), 'stop');

  root.on('bail', () => false);
  root.on('bail', () => 42);
  assert.equal(root.bail('bail'), 42);

  root.on('waterfall', (value, next) => `outer(${String((next as () => unknown)())}:${value})`);
  root.on('waterfall', (value, next) => `inner(${String((next as () => unknown)())}:${value})`);
  assert.equal(
    root.waterfall('waterfall', 'x', () => 'base'),
    'outer(inner(base:x):x)',
  );
  await root.fiber.dispose();
});

test('event hooks are not published while their Fiber is unloading', async () => {
  const root = new Context();
  let calls = 0;
  const fiber = root.plugin((ctx) => () => {
    ctx.on('late-hook', () => {
      calls += 1;
    });
  });
  await fiber.await();

  await assert.rejects(fiber.dispose(), AggregateError);
  root.emit('late-hook');

  assert.equal(calls, 0);
  await root.fiber.dispose();
});

test('unloading Contexts cannot create escaping child Fibers', async () => {
  const root = new Context();
  let childActivations = 0;
  const fiber = root.plugin((ctx) => () => {
    ctx.plugin(() => {
      childActivations += 1;
    });
  });
  await fiber.await();

  await assert.rejects(fiber.dispose(), AggregateError);
  assert.equal(childActivations, 0);
  assert.deepEqual(
    root.kernelFibers().map(({ id }) => id),
    [0],
  );
  await root.fiber.dispose();
});

test('dispose requests immediately fence child Fiber creation and Service labels', async () => {
  const root = new Context();
  let context!: Context;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fiber = root.plugin(async (ctx, config: string) => {
    context = ctx;
    if (config === 'slow') await gate;
  }, 'ready');
  await fiber.await();

  const update = fiber.update('slow');
  await new Promise<void>((resolve) => setImmediate(resolve));
  const dispose = fiber.dispose();

  assert.throws(() => context.plugin(() => undefined), /Plugin Context is disposed/u);
  assert.throws(
    () => context.provide('lateService', { value: true }),
    /Plugin Context is disposed/u,
  );
  assert.equal(root._kernel().serviceLabels.has('lateService'), false);

  release();
  await update;
  await dispose;
  await root.fiber.dispose();
});

test('late contribution registration is rejected before acquiring resources', async () => {
  const root = new Context();
  let registrations = 0;
  const fiber = root.plugin((ctx) => () => {
    registerPluginContribution(ctx, 'late-contribution', () => {
      registrations += 1;
      return () => undefined;
    });
  });
  await fiber.await();

  await assert.rejects(fiber.dispose(), AggregateError);
  assert.equal(registrations, 0);
  await root.fiber.dispose();
});

test('intercept configuration is inherited without mutating parent Contexts', async () => {
  const root = new Context();
  const child = root.intercept('fixture', { child: true });
  const grandchild = child.intercept('fixture', { grandchild: true });

  assert.deepEqual(root.interceptConfig('fixture'), []);
  assert.deepEqual(child.interceptConfig('fixture'), [{ child: true }]);
  assert.deepEqual(grandchild.interceptConfig('fixture'), [{ child: true }, { grandchild: true }]);
  await root.fiber.dispose();
});

test('Service records support names inherited from Object.prototype', async () => {
  class FixtureService extends Service<Record<string, unknown>> {
    merge(): Record<string, unknown> {
      return this.resolveConfig({ base: true });
    }
  }

  const root = new Context();
  const intercepted = root.intercept('constructor', { intercepted: true });
  const isolated = intercepted.isolate('constructor');
  const service = new FixtureService(isolated, 'constructor');
  const bound = isolated.get<FixtureService>('constructor');

  assert.deepEqual(intercepted.interceptConfig('constructor'), [{ intercepted: true }]);
  assert.ok(bound);
  assert.deepEqual(bound.merge(), { base: true, intercepted: true });
  assert.deepEqual(service.merge(), { base: true, intercepted: true });
  await root.fiber.dispose();
});
