import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ExtensionRuntimeContext,
  ExtensionRuntimeContextError,
} from '../extension-runtime-context.js';

test('Context tree inherits capabilities and disposes children and effects in reverse order', async () => {
  const root = ExtensionRuntimeContext.root();
  const scope = root.fork({ id: 'profile', kind: 'scope' });
  const provider = scope.fork({ id: 'provider', kind: 'plugin' });
  const consumer = scope.fork({ id: 'consumer', kind: 'plugin' });
  const disposed: string[] = [];

  provider.own('provider-resource', () => {
    disposed.push('provider-resource');
  });
  provider.provide('weather.reader', { read: () => 'sunny' });
  consumer.own('consumer-first', () => {
    disposed.push('consumer-first');
  });
  consumer.own('consumer-second', () => {
    disposed.push('consumer-second');
  });

  assert.equal(consumer.require<{ read(): string }>('weather.reader').read(), 'sunny');
  assert.deepEqual(
    root.inspect().children[0]?.children.map(({ id }) => id),
    ['consumer', 'provider'],
  );

  await scope.close();
  assert.deepEqual(disposed, ['consumer-second', 'consumer-first', 'provider-resource']);
  assert.deepEqual(root.inspect().children, []);
  assert.throws(() => consumer.require('weather.reader'), ExtensionRuntimeContextError);
});

test('Context capability ownership prevents ambiguous sibling providers', async () => {
  const root = ExtensionRuntimeContext.root();
  const scope = root.fork({ id: 'profile', kind: 'scope' });
  const first = scope.fork({ id: 'first', kind: 'plugin' });
  const second = scope.fork({ id: 'second', kind: 'plugin' });

  first.provide('audit.writer', { source: 'first' });
  assert.throws(() => second.provide('audit.writer', { source: 'second' }), /already provided/u);
  await first.close();
  second.provide('audit.writer', { source: 'second' });
  assert.equal(scope.require<{ source: string }>('audit.writer').source, 'second');
});

test('Context capability ownership stacks replacement candidates without losing current on rollback', async () => {
  const root = ExtensionRuntimeContext.root();
  const scope = root.fork({ id: 'profile', kind: 'scope' });
  const current = scope.fork({
    id: 'weather:current',
    kind: 'plugin',
    replacementKey: 'weather',
  });
  const candidate = scope.fork({
    id: 'weather:candidate',
    kind: 'plugin',
    replacementKey: 'weather',
    status: 'preparing',
  });

  current.provide('weather.reader', { revision: 'v1' });
  candidate.provide('weather.reader', { revision: 'v2' });
  assert.equal(scope.require<{ revision: string }>('weather.reader').revision, 'v2');

  await candidate.close();
  assert.equal(scope.require<{ revision: string }>('weather.reader').revision, 'v1');

  const committed = scope.fork({
    id: 'weather:committed',
    kind: 'plugin',
    replacementKey: 'weather',
    status: 'preparing',
  });
  committed.provide('weather.reader', { revision: 'v2' });
  committed.activate();
  await current.close();
  assert.equal(scope.require<{ revision: string }>('weather.reader').revision, 'v2');
});
