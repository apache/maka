import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Context, type Plugin } from '../plugin-kernel.js';
import { z } from 'zod';
import { MakaCompositionLoader } from '../plugin-composition-loader.js';
import { PluginToolService } from '../plugin-tool-service.js';
import type { MakaCompositionEntry, MakaPluginPackage } from '../plugin-runtime.js';

test('composition tree supports nested groups and repeated package instances', async () => {
  const activations: string[] = [];
  const plugin = ((ctx: Context, config: { label: string }) => {
    activations.push(`${ctx.maka!.entryId}:${config.label}`);
    ctx.effect(() => () => activations.push(`dispose:${ctx.maka!.entryId}`), 'fixture');
  }) as Plugin;
  const loader = new MakaCompositionLoader();
  await loader.install(pkg('fixture', plugin));
  await loader.create('profile', {
    id: 'group',
    children: [
      entry('first', 'fixture', { label: 'one' }),
      entry('second', 'fixture', { label: 'two' }),
    ],
  });
  assert.deepEqual(activations, ['first:one', 'second:two']);
  assert.deepEqual(
    loader.inspectTree('profile').map(({ id }) => id),
    ['group'],
  );
  assert.deepEqual(
    loader.inspect('group').children.map(({ id }) => id),
    ['first', 'second'],
  );
  assert.equal(loader.root.kernelFibers().length, 3, 'root plus one real Fiber per package Entry');
  await loader.remove('first');
  assert.equal(loader.inspect('second').status, 'active');
  assert.ok(activations.includes('dispose:first'));
  await loader.close();
});

test('missing injected service enters pending and activates when provided', async () => {
  let started = 0;
  const plugin = Object.assign(
    () => {
      started += 1;
    },
    { inject: ['fixtureService'] },
  );
  const loader = new MakaCompositionLoader();
  await loader.install(pkg('consumer', plugin));
  await loader.create('profile', entry('consumer-one', 'consumer'));
  assert.equal(loader.inspect('consumer-one').status, 'pending');
  loader.root.provide('fixtureService', { value: 1 });
  await loader.awaitSettled();
  assert.equal(loader.inspect('consumer-one').status, 'active');
  assert.equal(started, 1);
  await loader.close();
});

test('config update uses the existing Fiber and preserves entry identity', async () => {
  const values: number[] = [];
  const plugin = (_ctx: Context, config: { value: number }) => {
    values.push(config.value);
  };
  const loader = new MakaCompositionLoader();
  await loader.install(pkg('configurable', plugin));
  const initial = await loader.create(
    'profile',
    entry('configurable-one', 'configurable', { value: 1 }),
  );
  const updated = await loader.update('configurable-one', { config: { value: 2 } });
  assert.equal(updated.id, initial.id);
  assert.equal(updated.generation, initial.generation);
  assert.equal(loader.snapshot().generation, 2);
  assert.deepEqual(values, [1, 2]);
  await loader.close();
});

test('package reload is atomic when the candidate Fiber fails', async () => {
  const live = new Set<string>();
  const current = (ctx: Context) => {
    live.add(ctx.maka!.entryId);
    return () => live.delete(ctx.maka!.entryId);
  };
  const failed = () => {
    throw new Error('candidate exploded');
  };
  const loader = new MakaCompositionLoader();
  await loader.install(pkg('atomic', current));
  await loader.create('profile', entry('atomic-one', 'atomic'));
  await assert.rejects(() => loader.install(pkg('atomic', failed)), /candidate exploded/u);
  assert.equal(loader.inspect('atomic-one').status, 'active');
  assert.deepEqual([...live], ['atomic-one']);
  await loader.close();
});

test('package reload replaces only affected Entry subtrees', async () => {
  const activations: string[] = [];
  const loader = new MakaCompositionLoader();
  await loader.install(
    pkg('changing', (ctx: Context) => {
      activations.push(`changing:${ctx.maka!.generation}`);
    }),
  );
  await loader.install(
    pkg('stable', (ctx: Context) => {
      activations.push(`stable:${ctx.maka!.generation}`);
    }),
  );
  await loader.create('profile', entry('changing-entry', 'changing'));
  await loader.create('profile', entry('stable-entry', 'stable'));
  const stableGeneration = loader.inspect('stable-entry').generation;

  await loader.install(
    pkg('changing', (ctx: Context) => {
      activations.push(`changed:${ctx.maka!.generation}`);
    }),
  );

  assert.notEqual(loader.inspect('changing-entry').generation, undefined);
  assert.equal(loader.inspect('stable-entry').generation, stableGeneration);
  assert.equal(activations.filter((item) => item.startsWith('stable:')).length, 1);
  await loader.close();
});

test('Tool registrations are staged and owned by the entry Fiber', async () => {
  const root = new Context();
  await root.plugin(PluginToolService);
  const loader = new MakaCompositionLoader({ root });
  const plugin = Object.assign(
    (ctx: Context, config: { suffix: string }) => {
      ctx.tools.register({
        name: `hello_${config.suffix}`,
        description: 'fixture',
        parameters: z.object({}),
        impl: async () => config.suffix,
      });
    },
    { inject: ['tools'] },
  );
  await loader.install(pkg('tool-owner', plugin));
  await loader.create('profile', entry('tool-a', 'tool-owner', { suffix: 'a' }));
  await loader.create('profile', entry('tool-b', 'tool-owner', { suffix: 'b' }));
  assert.deepEqual(
    root.tools.inspect('profile').map(({ toolName }) => toolName),
    ['hello_a', 'hello_b'],
  );
  await loader.remove('tool-a');
  assert.deepEqual(
    root.tools.inspect('profile').map(({ toolName }) => toolName),
    ['hello_b'],
  );
  await loader.close();
});

test('snapshot replacement restores ordered roots and descendants', async () => {
  const loader = new MakaCompositionLoader();
  await loader.install(pkg('snapshot', () => undefined));
  await loader.replaceSnapshot({
    schemaVersion: 1,
    generation: 41,
    roots: {
      profile: [entry('profile-entry', 'snapshot')],
      desktopUi: [{ id: 'ui-group', children: [entry('ui-entry', 'snapshot')] }],
      sessions: { s1: [entry('session-entry', 'snapshot')] },
    },
  });
  assert.equal(loader.snapshot().generation >= 41, true);
  assert.deepEqual(
    loader.inspectTree().map(({ id }) => id),
    ['profile-entry', 'ui-group', 'session-entry'],
  );
  assert.equal(loader.inspect('ui-entry').parentId, 'ui-group');
  await loader.close();
});

test('composition apply batches EntryTree operations under one generation check', async () => {
  const loader = new MakaCompositionLoader();
  await loader.install(pkg('batch', () => undefined));
  const initial = loader.snapshot().generation;
  const changed = await loader.apply({
    baseGeneration: initial,
    operations: [
      { type: 'insert', entry: entry('batch-a', 'batch') },
      { type: 'insert', parentId: 'batch-a', entry: { id: 'batch-group' } },
      { type: 'update', entryId: 'batch-group', patch: { disabled: true } },
    ],
  });
  assert.deepEqual(
    changed.map(({ id }) => id),
    ['batch-a', 'batch-group', 'batch-group'],
  );
  assert.equal(loader.inspect('batch-group').disabled, true);
  await assert.rejects(
    () => loader.apply({ baseGeneration: initial, operations: [] }),
    /Composition generation changed/u,
  );
  await loader.close();
});

function pkg(packageId: string, host: Plugin): MakaPluginPackage {
  return Object.freeze({ packageId, host });
}

function entry(id: string, packageId: string, config?: unknown): MakaCompositionEntry {
  return Object.freeze({ id, packageId, ...(config === undefined ? {} : { config }) });
}
