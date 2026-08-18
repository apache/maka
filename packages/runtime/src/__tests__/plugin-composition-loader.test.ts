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
  await loader.install(pkg('fixture', 'r1', plugin));
  await loader.create('profile', {
    id: 'group',
    children: [
      entry('first', 'fixture', 'r1', { label: 'one' }),
      entry('second', 'fixture', 'r1', { label: 'two' }),
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
  await loader.install(pkg('consumer', 'r1', plugin));
  await loader.create('profile', entry('consumer-one', 'consumer', 'r1'));
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
  await loader.install(pkg('configurable', 'r1', plugin));
  const initial = await loader.create(
    'profile',
    entry('configurable-one', 'configurable', 'r1', { value: 1 }),
  );
  const updated = await loader.update('configurable-one', { config: { value: 2 } });
  assert.equal(updated.id, initial.id);
  assert.ok(updated.generation! > initial.generation!);
  assert.deepEqual(values, [1, 2]);
  await loader.close();
});

test('revision replacement is atomic when the candidate fails', async () => {
  const live = new Set<string>();
  const current = (ctx: Context) => {
    live.add(ctx.maka!.revision);
    return () => live.delete(ctx.maka!.revision);
  };
  const failed = () => {
    throw new Error('candidate exploded');
  };
  const loader = new MakaCompositionLoader();
  await loader.install(pkg('atomic', 'r1', current));
  await loader.install(pkg('atomic', 'r2', failed));
  await loader.create('profile', entry('atomic-one', 'atomic', 'r1'));
  await assert.rejects(() => loader.replaceRevision('atomic-one', 'r2'), /candidate exploded/u);
  assert.equal(loader.inspect('atomic-one').revision, 'r1');
  assert.deepEqual([...live], ['r1']);
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
  await loader.install(pkg('tool-owner', 'r1', plugin));
  await loader.create('profile', entry('tool-a', 'tool-owner', 'r1', { suffix: 'a' }));
  await loader.create('profile', entry('tool-b', 'tool-owner', 'r1', { suffix: 'b' }));
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
  await loader.install(pkg('snapshot', 'r1', () => undefined));
  await loader.replaceSnapshot({
    schemaVersion: 1,
    generation: 41,
    roots: {
      profile: [entry('profile-entry', 'snapshot', 'r1')],
      desktopUi: [{ id: 'ui-group', children: [entry('ui-entry', 'snapshot', 'r1')] }],
      sessions: { s1: [entry('session-entry', 'snapshot', 'r1')] },
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

function pkg(packageId: string, revision: string, host: Plugin): MakaPluginPackage {
  return Object.freeze({ packageId, revision, host });
}

function entry(
  id: string,
  packageId: string,
  revision: string,
  config?: unknown,
): MakaCompositionEntry {
  return Object.freeze({ id, packageId, revision, ...(config === undefined ? {} : { config }) });
}
