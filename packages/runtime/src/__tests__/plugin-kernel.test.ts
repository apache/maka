import assert from 'node:assert/strict';
import test from 'node:test';
import { Context, FiberState, type Plugin } from '../plugin-kernel.js';

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

  root.on('serial', () => undefined);
  root.on('serial', () => 'stop');
  root.on('serial', () => 'unreachable');
  assert.equal(await root.serial('serial'), 'stop');

  root.on('bail', () => false);
  root.on('bail', () => 42);
  assert.equal(root.bail('bail'), 42);

  root.on('waterfall', (value, next) => `outer(${String((next as () => unknown)())}:${value})`);
  root.on('waterfall', (value, next) => `inner(${String((next as () => unknown)())}:${value})`);
  assert.equal(root.waterfall('waterfall', 'x', () => 'base'), 'outer(inner(base:x):x)');
  await root.fiber.dispose();
});

test('intercept configuration is inherited without mutating parent Contexts', async () => {
  const root = new Context();
  const child = root.intercept('fixture', { child: true });
  const grandchild = child.intercept('fixture', { grandchild: true });

  assert.deepEqual(root.interceptConfig('fixture'), []);
  assert.deepEqual(child.interceptConfig('fixture'), [{ child: true }]);
  assert.deepEqual(grandchild.interceptConfig('fixture'), [
    { child: true },
    { grandchild: true },
  ]);
  await root.fiber.dispose();
});
