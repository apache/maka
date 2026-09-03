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
import { test } from 'node:test';
import { Context, type Fiber, type Plugin } from '../plugin-kernel.js';
import { MakaCompositionLoader } from '../plugin-composition-loader.js';
import {
  applyCompositionState,
  MakaPluginTransactionBuffer,
  type MakaCompositionEntry,
  type MakaPluginPackage,
} from '../plugin-runtime.js';

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

test('package Entry descendants stay owned by the parent package Fiber', async () => {
  const fibers = new Map<string, Fiber>();
  const capture = (ctx: Context) => {
    fibers.set(ctx.maka!.entryId, ctx.fiber);
  };
  const loader = new MakaCompositionLoader();
  await loader.install(pkg('parent-package', capture));
  await loader.install(pkg('child-package', capture));

  await loader.create('profile', entry('parent-entry', 'parent-package'));
  await loader.create('profile', entry('child-entry', 'child-package'), 'parent-entry');
  assert.equal(fibers.get('child-entry')?.parent, fibers.get('parent-entry'));

  await loader.create('profile', { id: 'scope-group' });
  await loader.move('child-entry', 'scope-group');
  assert.equal(fibers.get('child-entry')?.parent, loader.root.fiber);
  await loader.move('child-entry', 'parent-entry');
  assert.equal(fibers.get('child-entry')?.parent, fibers.get('parent-entry'));

  await loader.recoverComposition({
    schemaVersion: 1,
    generation: 7,
    roots: {
      profile: [
        {
          ...entry('parent-entry', 'parent-package'),
          children: [entry('child-entry', 'child-package')],
        },
      ],
      desktopUi: [],
      sessions: {},
    },
  });
  assert.equal(fibers.get('child-entry')?.parent, fibers.get('parent-entry'));

  await loader.reload(pkg('parent-package', capture));
  assert.equal(fibers.get('child-entry')?.parent, fibers.get('parent-entry'));
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

test('composition metadata wins over same-named root Services', async () => {
  const root = new Context();
  root.provide('maka', { hijacked: true });
  let seenEntryId: string | undefined;
  const loader = new MakaCompositionLoader({ root });
  await loader.install(
    pkg('metadata-owner', (ctx: Context) => {
      seenEntryId = ctx.maka?.entryId;
    }),
  );

  await loader.create('profile', entry('metadata-entry', 'metadata-owner'));

  assert.equal(seenEntryId, 'metadata-entry');
  assert.deepEqual(root.get('maka'), { hijacked: true });
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
  assert.equal(loader.compositionState().generation, 2);
  assert.deepEqual(values, [1, 2]);
  await loader.close();
});

test('duplicate package install is rejected without replacing live code', async () => {
  const live = new Set<string>();
  const current = (ctx: Context) => {
    live.add(ctx.maka!.entryId);
    return () => live.delete(ctx.maka!.entryId);
  };
  const replacement = () => undefined;
  const loader = new MakaCompositionLoader();
  await loader.install(pkg('atomic', current));
  await loader.create('profile', entry('atomic-one', 'atomic'));
  await assert.rejects(
    () => loader.install(pkg('atomic', replacement)),
    /Plugin package is already installed: atomic/u,
  );
  assert.equal(loader.inspect('atomic-one').status, 'active');
  assert.equal(loader.package('atomic').host, current);
  assert.deepEqual([...live], ['atomic-one']);
  await loader.close();
});

test('remove and close exhaust subtree cleanup across retirement failures', async (t) => {
  t.mock.method(console, 'warn', () => undefined);
  const createLoader = async (lifecycle: string[]) => {
    const loader = new MakaCompositionLoader();
    await loader.install(
      pkg(
        'cleanup',
        (_ctx: Context, config: { readonly label: string; readonly fail?: boolean }) => {
          return () => {
            lifecycle.push(config.label);
            if (config.fail) throw new Error(`${config.label} cleanup failed`);
          };
        },
      ),
    );
    await loader.create('profile', {
      id: 'cleanup-group',
      children: [
        entry('cleanup-first', 'cleanup', { label: 'first', fail: true }),
        entry('cleanup-second', 'cleanup', { label: 'second' }),
      ],
    });
    return loader;
  };

  const removed: string[] = [];
  const removeLoader = await createLoader(removed);
  await removeLoader.remove('cleanup-group');
  assert.deepEqual(removed, ['second', 'first']);
  await removeLoader.close();

  const closed: string[] = [];
  const closeLoader = await createLoader(closed);
  await assert.rejects(closeLoader.close(), AggregateError);
  assert.deepEqual(closed, ['second', 'first']);
});

test('disabled ancestors suppress insert, move, update, and subtree replacement activation', async () => {
  const activations: string[] = [];
  const loader = new MakaCompositionLoader();
  await loader.install(
    pkg('disabled-child', (ctx: Context, config: { readonly value: string }) => {
      activations.push(`${ctx.maka!.entryId}:${config.value}`);
    }),
  );
  await loader.create('profile', { id: 'disabled-parent', disabled: true });

  await loader.create(
    'profile',
    entry('inserted-child', 'disabled-child', { value: 'inserted' }),
    'disabled-parent',
  );
  assert.equal(loader.inspect('inserted-child').disabled, true);
  assert.equal(loader.inspect('inserted-child').status, 'disabled');

  await loader.create('profile', entry('moved-child', 'disabled-child', { value: 'before-move' }));
  assert.deepEqual(activations, ['moved-child:before-move']);
  await loader.move('moved-child', 'disabled-parent');
  assert.equal(loader.inspect('moved-child').status, 'disabled');

  await loader.replaceSubtree(
    'inserted-child',
    entry('inserted-child', 'disabled-child', { value: 'replaced' }),
  );
  await loader.update('inserted-child', { config: { value: 'updated' } });

  assert.deepEqual(activations, ['moved-child:before-move']);
  assert.equal(loader.inspect('inserted-child').status, 'disabled');
  assert.equal(loader.inspect('moved-child').status, 'disabled');
  await loader.close();
});

test('insert commit failure disposes its unindexed Fiber exactly once', async () => {
  let disposals = 0;
  const loader = new MakaCompositionLoader();
  await loader.install(
    pkg('commit-failure', (ctx: Context) => {
      ctx.makaTransaction!.stage(
        'first',
        () => () => {
          disposals += 1;
        },
        ctx,
      );
      ctx.makaTransaction!.stage(
        'failure',
        () => {
          throw new Error('registration failed');
        },
        ctx,
      );
    }),
  );

  await assert.rejects(
    loader.create('profile', entry('failed-entry', 'commit-failure')),
    /registration failed/u,
  );

  assert.deepEqual(loader.inspectTree('profile'), []);
  assert.equal(loader.root.kernelFibers().length, 1);
  assert.equal(disposals, 1);
  await loader.close();
  assert.equal(disposals, 1);
});

test('transaction commit failure rolls registrations back sequentially in LIFO order', async () => {
  const lifecycle: string[] = [];
  let laterDisposed = false;
  const loader = new MakaCompositionLoader();
  await loader.install(
    pkg('ordered-rollback', (ctx: Context) => {
      ctx.makaTransaction!.stage(
        'first',
        () => () => {
          lifecycle.push(laterDisposed ? 'first-after-later' : 'first-overlapped-later');
        },
        ctx,
      );
      ctx.makaTransaction!.stage(
        'later',
        () => async () => {
          await Promise.resolve();
          laterDisposed = true;
          lifecycle.push('later');
        },
        ctx,
      );
      ctx.makaTransaction!.stage(
        'failure',
        () => {
          throw new Error('registration failed');
        },
        ctx,
      );
    }),
  );

  await assert.rejects(
    loader.create('profile', entry('ordered-rollback-entry', 'ordered-rollback')),
    /registration failed/u,
  );

  assert.deepEqual(lifecycle, ['later', 'first-after-later']);
  await loader.close();
});

test('retirement cleanup failure does not roll back a published removal generation', async (t) => {
  t.mock.method(console, 'warn', () => undefined);
  const loader = new MakaCompositionLoader();
  await loader.install(
    pkg('retirement-failure', () => () => {
      throw new Error('retirement failed');
    }),
  );
  await loader.create('profile', entry('retired-entry', 'retirement-failure'));
  const generation = loader.compositionState().generation;

  await loader.remove('retired-entry');

  assert.equal(loader.compositionState().generation, generation + 1);
  assert.deepEqual(loader.inspectTree('profile'), []);
  await loader.close();
});

test('retirement cleanup failure does not roll back a published structural update', async (t) => {
  t.mock.method(console, 'warn', () => undefined);
  const loader = new MakaCompositionLoader();
  await loader.install(
    pkg('retired-package', () => () => {
      throw new Error('retirement failed');
    }),
  );
  await loader.install(pkg('replacement-package', () => undefined));
  await loader.create('profile', entry('updated-entry', 'retired-package'));
  const generation = loader.compositionState().generation;

  await loader.update('updated-entry', { packageId: 'replacement-package' });

  assert.equal(loader.compositionState().generation, generation + 1);
  assert.equal(loader.inspect('updated-entry').packageId, 'replacement-package');
  assert.equal(loader.inspect('updated-entry').status, 'active');
  await loader.close();
});

test('contribution registrations are staged and owned by the entry Fiber', async () => {
  const root = new Context();
  const registrations = new Set<string>();
  const loader = new MakaCompositionLoader({
    root,
    transaction: (context) => new MakaPluginTransactionBuffer(context),
  });
  const plugin = (ctx: Context, config: { suffix: string }) => {
    ctx.makaTransaction!.stage(
      `fixture:${config.suffix}`,
      () => {
        registrations.add(config.suffix);
        return () => {
          registrations.delete(config.suffix);
        };
      },
      ctx,
    );
  };
  await loader.install(pkg('owner', plugin));
  await loader.create('profile', entry('entry-a', 'owner', { suffix: 'a' }));
  await loader.create('profile', entry('entry-b', 'owner', { suffix: 'b' }));
  assert.deepEqual([...registrations], ['a', 'b']);
  await loader.remove('entry-a');
  assert.deepEqual([...registrations], ['b']);
  await loader.close();
});

test('state replacement restores ordered roots and descendants', async () => {
  const loader = new MakaCompositionLoader();
  await loader.install(pkg('state', () => undefined));
  await loader.replaceComposition({
    schemaVersion: 1,
    generation: 41,
    roots: {
      profile: [entry('profile-entry', 'state')],
      desktopUi: [{ id: 'ui-group', children: [entry('ui-entry', 'state')] }],
      sessions: { s1: [entry('session-entry', 'state')] },
    },
  });
  assert.equal(loader.compositionState().generation, 41);
  assert.deepEqual(
    loader.inspectTree().map(({ id }) => id),
    ['profile-entry', 'ui-group', 'session-entry'],
  );
  assert.equal(loader.inspect('ui-entry').parentId, 'ui-group');
  await loader.close();
});

test('live state and subtree replacement publish a fresh composition generation', async () => {
  const loader = new MakaCompositionLoader();
  await loader.create('profile', { id: 'before' });
  const staleGeneration = loader.compositionState().generation;

  await loader.replaceComposition({
    schemaVersion: 1,
    generation: staleGeneration,
    roots: { profile: [{ id: 'after' }], desktopUi: [], sessions: {} },
  });

  assert.equal(loader.compositionState().generation, staleGeneration + 1);
  await assert.rejects(
    () => loader.apply({ baseGeneration: staleGeneration, operations: [] }),
    /Composition generation changed/u,
  );

  const beforeSubtreeReplacement = loader.compositionState().generation;
  await loader.replaceSubtree('after', { id: 'after', children: [{ id: 'child' }] });
  assert.equal(loader.compositionState().generation, beforeSubtreeReplacement + 1);
  await loader.close();
});

test('entry inject and intercept metadata retain the feat shallow-copy contract', async () => {
  const dependencyCheck = () => true;
  const interceptConfig = { select: () => true };
  const loader = new MakaCompositionLoader();

  await loader.create('profile', {
    id: 'metadata-group',
    inject: { fixtureService: dependencyCheck },
    intercept: { fixtureService: interceptConfig },
  });

  assert.equal(loader.inspect('metadata-group').status, 'active');
  await loader.close();
});

test('replacement subtrees reject duplicate ids across different branches', async () => {
  const loader = new MakaCompositionLoader();
  await loader.create('profile', { id: 'replacement-root' });

  await assert.rejects(
    loader.replaceSubtree('replacement-root', {
      id: 'replacement-root',
      children: [
        { id: 'left-branch', children: [{ id: 'repeated-child' }] },
        { id: 'right-branch', children: [{ id: 'repeated-child' }] },
      ],
    }),
    /Replacement subtree repeats entry repeated-child/u,
  );

  assert.deepEqual(loader.inspect('replacement-root').children, []);
  await loader.close();
});

test('state preserves session ids that overlap object prototype properties', async () => {
  const loader = new MakaCompositionLoader();
  const reduced = applyCompositionState(loader.compositionState(), {
    operations: [
      {
        type: 'insert',
        rootId: 'session:__proto__',
        entry: { id: 'reduced-special-session-entry' },
      },
    ],
  });
  assert.equal(Object.hasOwn(reduced.roots.sessions, '__proto__'), true);
  assert.deepEqual(
    reduced.roots.sessions.__proto__?.map(({ id }) => id),
    ['reduced-special-session-entry'],
  );

  await loader.create('session:__proto__', { id: 'special-session-entry' });

  const state = loader.compositionState();
  assert.equal(Object.hasOwn(state.roots.sessions, '__proto__'), true);
  assert.deepEqual(
    state.roots.sessions.__proto__?.map(({ id }) => id),
    ['special-session-entry'],
  );

  await loader.replaceComposition(state);
  assert.deepEqual(
    loader.inspectTree('session:__proto__').map(({ id }) => id),
    ['special-session-entry'],
  );
  await loader.close();
});

test('inspecting a missing root does not mutate the composition state', async () => {
  const loader = new MakaCompositionLoader();
  const before = loader.compositionState();

  assert.deepEqual(loader.inspectTree('session:missing'), []);

  assert.deepEqual(loader.compositionState(), before);
  await loader.close();
});

test('failed insert does not create an empty composition root', async () => {
  const loader = new MakaCompositionLoader();
  const before = loader.compositionState();

  await assert.rejects(
    loader.create('session:ghost', { id: 'orphan' }, 'missing-parent'),
    /Composition entry not found: missing-parent/u,
  );

  assert.deepEqual(loader.compositionState(), before);
  await loader.close();
});

test('structural updates preserve descendants added after the parent was created', async () => {
  const loader = new MakaCompositionLoader();
  await loader.create('profile', { id: 'dynamic-group' });
  await loader.create('profile', { id: 'dynamic-child' }, 'dynamic-group');

  await loader.disable('dynamic-group');

  assert.equal(loader.inspect('dynamic-child').parentId, 'dynamic-group');
  assert.equal(loader.inspect('dynamic-child').disabled, true);
  assert.deepEqual(
    loader.compositionState().roots.profile[0]?.children?.map(({ id }) => id),
    ['dynamic-child'],
  );
  await loader.close();
});

test('failed rebind leaves parent and position unchanged', async () => {
  const loader = new MakaCompositionLoader();
  await loader.install(
    pkg('move-guard', (ctx: Context) => {
      if (ctx.interceptConfig('moveGuard').length) throw new Error('target rejected move');
    }),
  );
  await loader.create('profile', { id: 'target-parent', intercept: { moveGuard: true } });
  await loader.create('profile', entry('movable-entry', 'move-guard'));
  const before = loader.compositionState();

  await assert.rejects(loader.move('movable-entry', 'target-parent'), /target rejected move/u);

  assert.equal(loader.inspect('movable-entry').parentId, undefined);
  assert.deepEqual(loader.compositionState(), before);
  await loader.close();
});

test('inspection includes package dependencies and live Fiber failures', async () => {
  const loader = new MakaCompositionLoader();
  await loader.install(
    pkg(
      'diagnostic-consumer',
      Object.assign(
        () => {
          throw new Error('dependency activation failed');
        },
        { inject: ['packageService'] },
      ),
    ),
  );
  await loader.create('profile', entry('diagnostic-entry', 'diagnostic-consumer'));

  assert.deepEqual(loader.inspect('diagnostic-entry').waitingFor, ['packageService']);
  loader.root.provide('packageService', { ready: true });
  await loader.awaitSettled();

  const inspection = loader.inspect('diagnostic-entry');
  assert.equal(inspection.status, 'failed');
  assert.match(inspection.diagnostic ?? '', /dependency activation failed/u);
  await loader.close();
});

test('committed transactions reject late registration before acquiring resources', async (t) => {
  t.mock.method(console, 'warn', () => undefined);
  let registrations = 0;
  const loader = new MakaCompositionLoader();
  await loader.install(
    pkg('late-transaction', (ctx: Context) => () => {
      ctx.makaTransaction!.stage(
        'late-registration',
        () => {
          registrations += 1;
          return () => undefined;
        },
        ctx,
      );
    }),
  );
  await loader.create('profile', entry('late-transaction-entry', 'late-transaction'));

  await loader.remove('late-transaction-entry');

  assert.equal(registrations, 0);
  await loader.close();
});

test('callable config remains inspectable after publication', async () => {
  const config = () => 'callable';
  const loader = new MakaCompositionLoader();
  await loader.install(pkg('callable-config', () => undefined));

  const inspection = await loader.create(
    'profile',
    entry('callable-config-entry', 'callable-config', config),
  );

  assert.equal(inspection.config, config);
  assert.equal(loader.inspect('callable-config-entry').config, config);
  assert.equal(loader.compositionState().roots.profile[0]?.config, config);
  await loader.close();
});

test('callable intercept changes trigger structural Context replacement', async () => {
  const first = () => 'first';
  const second = () => 'second';
  const seen: unknown[] = [];
  const loader = new MakaCompositionLoader();
  await loader.install(
    pkg('callable-intercept', (ctx: Context) => {
      seen.push(ctx.interceptConfig('fixture')[0]);
    }),
  );
  await loader.create('profile', {
    id: 'callable-intercept-entry',
    packageId: 'callable-intercept',
    intercept: { fixture: first },
  });

  await loader.update('callable-intercept-entry', { intercept: { fixture: second } });

  assert.deepEqual(seen, [first, second]);
  assert.equal(loader.compositionState().roots.profile[0]?.intercept?.fixture, second);
  await loader.close();
});

test('staging and commit failures do not retain newly created session roots', async () => {
  const loader = new MakaCompositionLoader();
  await loader.install(
    pkg('activation-failure', () => {
      throw new Error('activation failed');
    }),
  );
  await loader.install(
    pkg('commit-root-failure', (ctx: Context) => {
      ctx.makaTransaction!.stage('failure', () => {
        throw new Error('commit failed');
      });
    }),
  );
  const before = loader.compositionState();

  await assert.rejects(
    loader.create('session:missing-package', entry('missing-package-entry', 'missing-package')),
    /not installed/u,
  );
  await assert.rejects(
    loader.create(
      'session:activation-failure',
      entry('activation-failure-entry', 'activation-failure'),
    ),
    /activation failed/u,
  );
  await assert.rejects(
    loader.create('session:commit-failure', entry('commit-failure-entry', 'commit-root-failure')),
    /commit failed/u,
  );

  assert.deepEqual(loader.compositionState(), before);
  await loader.close();
});

test('composition apply batches EntryTree operations under one generation check', async () => {
  const loader = new MakaCompositionLoader();
  await loader.install(pkg('batch', () => undefined));
  const initial = loader.compositionState().generation;
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

test('failed composition batches restore the prior generation exactly', async () => {
  const loader = new MakaCompositionLoader();
  await loader.create('profile', { id: 'stable-entry' });
  const before = loader.compositionState();

  await assert.rejects(
    () =>
      loader.apply({
        baseGeneration: before.generation,
        operations: [
          { type: 'insert', entry: { id: 'temporary-entry' } },
          { type: 'update', entryId: 'missing-entry', patch: { disabled: true } },
        ],
      }),
    /Composition entry not found: missing-entry/u,
  );

  assert.deepEqual(loader.compositionState(), before);
  await loader.close();
});

test('failed composition batches preserve both the operation and rollback failures', async () => {
  let activations = 0;
  const loader = new MakaCompositionLoader();
  await loader.install(
    pkg('rollback-failure', () => {
      activations += 1;
      if (activations > 1) throw new Error('rollback activation failed');
    }),
  );
  await loader.create('profile', entry('stable-entry', 'rollback-failure'));

  await assert.rejects(
    () =>
      loader.apply({
        operations: [
          { type: 'insert', entry: { id: 'temporary-entry' } },
          { type: 'update', entryId: 'missing-entry', patch: { disabled: true } },
        ],
      }),
    (error: unknown) =>
      error instanceof AggregateError &&
      error.errors.length === 2 &&
      error.errors.some((cause) => /missing-entry/u.test(String(cause))) &&
      error.errors.some((cause) => /rollback activation failed/u.test(String(cause))),
  );

  await loader.close();
});

test('package reload replaces every matching mount without restarting unrelated Entries', async () => {
  const events: string[] = [];
  const host =
    (label: string): Plugin =>
    (ctx: Context) => {
      events.push(`start:${label}:${ctx.maka!.entryId}`);
      ctx.effect(() => () => events.push(`stop:${label}:${ctx.maka!.entryId}`), label);
    };
  const loader = new MakaCompositionLoader();
  await loader.install(pkg('reload-target', host('old')));
  await loader.install(pkg('reload-bystander', host('bystander')));
  await loader.create('profile', entry('reload-one', 'reload-target'));
  await loader.create('session:one', entry('reload-two', 'reload-target'));
  await loader.create('profile', entry('reload-unrelated', 'reload-bystander'));
  const unrelatedGeneration = loader.inspect('reload-unrelated').generation;
  const desiredGeneration = loader.compositionState().generation;

  await loader.reload(pkg('reload-target', host('new')));

  assert.equal(loader.inspect('reload-unrelated').generation, unrelatedGeneration);
  assert.equal(loader.compositionState().generation, desiredGeneration);
  assert.deepEqual(
    events.filter((event) => event.startsWith('start:new')),
    ['start:new:reload-one', 'start:new:reload-two'],
  );
  assert.equal(events.includes('stop:bystander:reload-unrelated'), false);
  await loader.close();
});

test('partial recovery preserves desired generation and isolates failed siblings', async () => {
  const loader = new MakaCompositionLoader();
  await loader.install(pkg('recoverable', () => undefined));
  const failures = await loader.recoverComposition({
    schemaVersion: 1,
    generation: 7,
    roots: {
      profile: [entry('recovered-entry', 'recoverable'), entry('missing-entry', 'missing-package')],
      desktopUi: [],
      sessions: {},
    },
  });

  assert.deepEqual(
    failures.map(({ entryId }) => entryId),
    ['missing-entry'],
  );
  assert.equal(loader.inspect('recovered-entry').status, 'active');
  assert.throws(() => loader.inspect('missing-entry'), /not found/u);
  assert.equal(loader.compositionState().generation, 7);
  await loader.close();
});

test('desired-state reducer applies dependent operations without activating code', () => {
  const initial = {
    schemaVersion: 1,
    generation: 3,
    roots: {
      profile: [{ id: 'parent', children: [{ id: 'child' }] }],
      desktopUi: [],
      sessions: {},
    },
  } as const;

  const next = applyCompositionState(initial, {
    baseGeneration: 3,
    operations: [
      { type: 'update', entryId: 'parent', patch: { disabled: true } },
      { type: 'update', entryId: 'child', patch: { disabled: true } },
      { type: 'move', entryId: 'child', position: 0 },
    ],
  });

  assert.equal(next.generation, 4);
  assert.deepEqual(next.roots.profile, [
    { id: 'child', disabled: true, children: [] },
    { id: 'parent', disabled: true, children: [] },
  ]);
});

test('desired-state reducer stays equivalent to live Entry Tree batch semantics', async () => {
  const loader = new MakaCompositionLoader();
  await loader.replaceComposition({
    schemaVersion: 1,
    generation: 4,
    roots: {
      profile: [
        { id: 'equivalence-a', children: [{ id: 'equivalence-a1' }, { id: 'equivalence-a2' }] },
        { id: 'equivalence-b' },
      ],
      desktopUi: [],
      sessions: {},
    },
  });
  const before = loader.compositionState();
  const input = {
    baseGeneration: before.generation,
    operations: [
      { type: 'update', entryId: 'equivalence-a', patch: { disabled: true } },
      {
        type: 'insert',
        parentId: 'equivalence-a',
        position: 1,
        entry: { id: 'equivalence-a3' },
      },
      { type: 'move', entryId: 'equivalence-a2', parentId: 'equivalence-b' },
      { type: 'remove', entryId: 'equivalence-a1' },
      { type: 'update', entryId: 'equivalence-a3', patch: { disabled: true } },
    ],
  } as const;

  const planned = applyCompositionState(before, input);
  await loader.apply(input);

  assert.deepEqual(loader.compositionState(), planned);
  await loader.close();
});

function pkg(packageId: string, host: Plugin): MakaPluginPackage {
  return Object.freeze({ packageId, host });
}

function entry(id: string, packageId: string, config?: unknown): MakaCompositionEntry {
  return Object.freeze({ id, packageId, ...(config === undefined ? {} : { config }) });
}
