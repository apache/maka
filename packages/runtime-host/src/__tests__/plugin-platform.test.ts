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
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { MakaCompositionLoader } from '@maka/runtime/plugin-composition-loader';
import {
  decodePluginCompositionApplyInput,
  decodeRequestFrame,
  decodeResponseFrame,
} from '../protocol/index.js';
import {
  HostPluginCompositionStore,
  HostPluginCompositionStoreError,
  type PersistedPluginComposition,
} from '../server/plugin-composition-store.js';
import { HostPluginPlatformCoordinator } from '../server/plugin-platform-coordinator.js';
import { TrustedPluginPackageLoader } from '../server/plugin-package-loader.js';
import { PluginPackageStore } from '../server/plugin-package-store.js';
import { HostPluginPlatform } from '../server/plugin-platform.js';

test('Plugin Platform installs, activates, persists, and recovers a generic package', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-plugin-platform-'));
  try {
    const source = await writeFixturePackage(root, 'fixture-package', 'first', {
      composition: [
        {
          type: 'insert',
          rootId: 'profile',
          entry: { id: 'fixture-entry', packageId: 'fixture-package' },
        },
      ],
    });
    const platform = new HostPluginPlatform(join(root, 'control'));
    await platform.recover();

    assert.deepEqual(await platform.installPackage(source), { extensionId: 'fixture-package' });
    const published = platform.composition.package('fixture-package');
    assert.deepEqual(published.contributions, [{ id: 'first', kind: 'foundation-test' }]);
    const bundle = join(root, 'fixture-package.maka-extension');
    await platform.packages.export('fixture-package', bundle);
    const imported = new HostPluginPlatform(join(root, 'import-control'));
    await imported.recover();
    assert.deepEqual(await imported.installPackage(bundle), { extensionId: 'fixture-package' });
    assert.equal(imported.inspect('profile')[0]?.id, 'fixture-entry');
    await imported.close();
    await platform.close();

    const recovered = new HostPluginPlatform(join(root, 'control'));
    await recovered.recover();
    assert.equal(recovered.inspect('profile')[0]?.status, 'active');
    assert.equal(recovered.desiredComposition().generation, 1);
    assert.deepEqual(recovered.composition.package('fixture-package').contributions, [
      { id: 'first', kind: 'foundation-test' },
    ]);
    assert.deepEqual(Object.keys((await recovered.store.read()) ?? {}).sort(), [
      'generation',
      'overlays',
      'packageLayers',
      'schemaVersion',
    ]);
    await recovered.close();

    const generationRoot = join(root, 'control', 'plugin-generations-v1');
    assert.deepEqual(await readdir(generationRoot).catch(() => []), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Plugin Platform coordinator keeps package and composition operations generic', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-plugin-protocol-'));
  try {
    const source = await writeFixturePackage(root, 'protocol-package', 'generic', {
      composition: [
        {
          type: 'insert',
          entry: { id: 'protocol-entry', packageId: 'protocol-package' },
        },
      ],
    });
    const platform = new HostPluginPlatform(join(root, 'control'));
    const coordinator = new HostPluginPlatformCoordinator(platform);
    await platform.recover();

    const installed = await coordinator.handlers['plugin.package.install'](
      { sourcePath: source },
      null as never,
    );
    assert.deepEqual(installed, {
      ok: true,
      result: { extensionId: 'protocol-package' },
    });
    const queried = await coordinator.handlers['plugin.platform.query'](
      { view: 'packages' },
      null as never,
    );
    assert.equal(queried.ok, true);
    if (queried.ok && queried.result.view === 'packages') {
      assert.deepEqual(
        queried.result.items.map(({ extensionId }) => extensionId),
        ['protocol-package'],
      );
    }
    const entries = await coordinator.handlers['plugin.platform.query'](
      { view: 'entries', rootId: 'profile' },
      null as never,
    );
    assert.equal(entries.ok && entries.result.view === 'entries', true);
    if (entries.ok && entries.result.view === 'entries') {
      assert.equal(entries.result.items[0]?.id, 'protocol-entry');
    }
    assert.deepEqual(
      await coordinator.handlers['plugin.package.reload'](
        { extensionId: 'protocol-package' },
        null as never,
      ),
      { ok: true, result: {} },
    );
    await platform.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('package Composition layers override in install order and unwind on uninstall', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-plugin-layers-'));
  try {
    const platform = new HostPluginPlatform(join(root, 'control'));
    await platform.recover();
    await platform.installPackage(
      await writeFixturePackage(root, 'layer-base', 'base', {
        manifest: {
          configuration: {
            properties: { theme: { type: 'string', default: 'base' } },
          },
        },
        composition: [
          {
            type: 'insert',
            entry: {
              id: 'layer-entry',
              packageId: 'layer-base',
              config: { theme: 'base' },
            },
          },
        ],
      }),
    );
    const overrideSource = await writeFixturePackage(root, 'layer-override', 'override', {
      composition: [
        { type: 'update', entryId: 'layer-entry', patch: { config: { theme: 'override' } } },
      ],
    });
    await platform.installPackage(overrideSource);
    const tailSource = await writeFixturePackage(root, 'layer-tail', 'tail', {
      composition: [
        { type: 'update', entryId: 'layer-entry', patch: { config: { theme: 'tail' } } },
      ],
    });
    await platform.installPackage(tailSource);

    assert.deepEqual(platform.desiredComposition().roots.profile[0]?.config, {
      theme: 'tail',
    });
    await platform.installPackage(overrideSource);
    assert.deepEqual(platform.desiredComposition().roots.profile[0]?.config, { theme: 'tail' });
    await platform.uninstallPackage('layer-tail');
    await platform.uninstallPackage('layer-override');
    assert.deepEqual(platform.desiredComposition().roots.profile[0]?.config, { theme: 'base' });
    await platform.installPackage(overrideSource);
    await platform.apply({
      operations: [
        { type: 'update', entryId: 'layer-entry', patch: { config: { theme: 'user' } } },
      ],
    });
    assert.deepEqual(platform.desiredComposition().roots.profile[0]?.config, { theme: 'user' });
    await platform.uninstallPackage('layer-override');
    assert.deepEqual(platform.desiredComposition().roots.profile[0]?.config, { theme: 'user' });
    assert.deepEqual((await platform.store.read())?.packageLayers, ['layer-base']);
    await platform.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('invalid package Composition patch is rejected before package publication', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-plugin-invalid-patch-'));
  try {
    const platform = new HostPluginPlatform(join(root, 'control'));
    await platform.recover();
    const source = await writeFixturePackage(root, 'invalid-patch', 'invalid', {
      composition: [{}],
    });
    await assert.rejects(() => platform.installPackage(source), /Composition patch is invalid/u);
    assert.deepEqual(await platform.packages.identities(), []);
    assert.deepEqual(platform.desiredComposition().roots.profile, []);

    const semanticSource = await writeFixturePackage(root, 'invalid-layer', 'invalid', {
      composition: [
        {
          type: 'insert',
          entry: { id: 'missing-package-entry', packageId: 'missing-package' },
        },
      ],
    });
    await assert.rejects(() => platform.installPackage(semanticSource), /missing-package/u);
    assert.deepEqual(await platform.packages.identities(), []);
    assert.deepEqual(platform.desiredComposition().roots.profile, []);
    await platform.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('failed package replacement restores both stored bytes and live Runtime package', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-plugin-rollback-'));
  try {
    const source = await writeFixturePackage(root, 'rollback-package', 'stable');
    const platform = new HostPluginPlatform(join(root, 'control'));
    await platform.recover();
    await platform.installPackage(source);
    await platform.apply({
      operations: [
        {
          type: 'insert',
          entry: { id: 'rollback-entry', packageId: 'rollback-package' },
        },
      ],
    });
    const before = platform.composition.package('rollback-package').contributions;
    const invalid = await writeFixturePackage(root, 'rollback-package', 'replacement', {
      runtimePackageId: 'wrong-package',
      directorySuffix: 'invalid',
    });

    await assert.rejects(() => platform.installPackage(invalid), /does not match manifest/u);
    assert.deepEqual(platform.composition.package('rollback-package').contributions, before);
    assert.equal(
      (await platform.packages.load('rollback-package')).manifest.id,
      'rollback-package',
    );
    await platform.close();

    const recovered = new HostPluginPlatform(join(root, 'control'));
    await recovered.recover();
    assert.deepEqual(recovered.composition.package('rollback-package').contributions, before);
    await recovered.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('package replacement recovery follows the durable Composition generation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-plugin-package-generation-'));
  try {
    for (const mode of ['before', 'after'] as const) {
      const control = join(root, mode);
      const store = new AmbiguousCompositionStore(control);
      const initial = new HostPluginPlatform(control, { store });
      await initial.recover();
      await initial.installPackage(
        await writeFixturePackage(root, `generation-${mode}`, 'stable', {
          composition: [
            {
              type: 'insert',
              entry: { id: `entry-${mode}`, packageId: `generation-${mode}` },
            },
          ],
        }),
      );
      store.mode = mode;
      const replacement = await writeFixturePackage(root, `generation-${mode}`, 'replacement', {
        directorySuffix: mode,
        composition: [
          {
            type: 'insert',
            entry: { id: `entry-${mode}`, packageId: `generation-${mode}` },
          },
        ],
      });
      await assert.rejects(() => initial.installPackage(replacement), /commit outcome is unknown/u);
      assert.equal(
        initial.composition.package(`generation-${mode}`).contributions?.[0]?.id,
        'stable',
        'Runtime convergence waits until the authority outcome is known',
      );
      await initial.close();

      const recovered = new HostPluginPlatform(control);
      await recovered.recover();
      assert.equal(
        recovered.composition.package(`generation-${mode}`).contributions?.[0]?.id,
        mode === 'after' ? 'replacement' : 'stable',
      );
      await recovered.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Plugin Platform protocol rejects open and malformed generic composition shapes', () => {
  assert.equal(
    decodeRequestFrame({
      requestId: 'plugin-reload',
      operation: 'plugin.package.reload',
      input: { extensionId: 'fixture-package' },
    }).operation,
    'plugin.package.reload',
  );
  assert.deepEqual(
    decodeRequestFrame({
      requestId: 'plugin-request',
      operation: 'plugin.composition.apply',
      input: {
        baseGeneration: 4,
        operations: [
          {
            type: 'insert',
            rootId: 'session:one',
            entry: {
              id: 'fixture-entry',
              packageId: 'fixture-package',
              config: { enabled: true },
              intercept: { policy: { nested: true } },
            },
          },
        ],
      },
    }).operation,
    'plugin.composition.apply',
  );
  assert.throws(() =>
    decodeRequestFrame({
      requestId: 'plugin-request',
      operation: 'plugin.package.install',
      input: { sourcePath: '/tmp/package', unexpected: true },
    }),
  );
  assert.throws(() =>
    decodeResponseFrame({
      requestId: 'plugin-request',
      operation: 'plugin.platform.query',
      ok: true,
      result: {
        view: 'entries',
        items: [],
        nextCursor: 'invalid',
      },
    }),
  );
});

test('durable overlays may accumulate beyond one command frame without oversized responses', () => {
  const input = {
    operations: Array.from({ length: 700 }, (_, index) => ({
      type: 'insert' as const,
      entry: { id: `large-entry-${index}`, config: { value: 'x'.repeat(900) } },
    })),
  };
  assert.throws(() => decodePluginCompositionApplyInput(input), /byte limit/u);
  assert.equal(decodePluginCompositionApplyInput(input, 2 * 1024 * 1024).operations.length, 700);
  assert.doesNotThrow(() =>
    decodeResponseFrame({
      requestId: 'large-apply',
      operation: 'plugin.composition.apply',
      ok: true,
      result: { generation: 700 },
    }),
  );
});

test('failed desired-state persistence leaves Runtime composition unchanged', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-plugin-persistence-'));
  try {
    const control = join(root, 'control');
    const store = new FailingCompositionStore(control);
    const source = await writeFixturePackage(root, 'persistent-package', 'stable');
    const platform = new HostPluginPlatform(control, { store });
    await platform.recover();
    await platform.installPackage(source);
    await platform.apply({
      operations: [
        {
          type: 'insert',
          entry: { id: 'persistent-entry', packageId: 'persistent-package' },
        },
      ],
    });
    const before = platform.composition.compositionState();
    store.fail = true;

    await assert.rejects(
      () =>
        platform.apply({
          baseGeneration: before.generation,
          operations: [{ type: 'update', entryId: 'persistent-entry', patch: { disabled: true } }],
        }),
      /Runtime state was not changed/u,
    );
    assert.deepEqual(platform.composition.compositionState(), before);
    assert.equal(platform.inspect('profile')[0]?.status, 'active');
    await platform.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('recovery loads installed packages that do not yet have an Entry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-plugin-unused-package-'));
  try {
    const control = join(root, 'control');
    const source = await writeFixturePackage(root, 'unused-package', 'available');
    const initial = new HostPluginPlatform(control);
    await initial.recover();
    await initial.installPackage(source);
    await initial.close();

    const recovered = new HostPluginPlatform(control);
    await recovered.recover();
    await recovered.apply({
      operations: [{ type: 'insert', entry: { id: 'later-entry', packageId: 'unused-package' } }],
    });
    assert.equal(recovered.inspect('profile')[0]?.status, 'active');
    await recovered.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('immutable package generation is owned by package lifetime across repeated Entries', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-plugin-generation-owner-'));
  try {
    const control = join(root, 'control');
    const platform = new HostPluginPlatform(control);
    await platform.recover();
    await platform.installPackage(await writeFixturePackage(root, 'shared-package', 'shared'));
    await platform.apply({
      operations: [
        { type: 'insert', entry: { id: 'shared-one', packageId: 'shared-package' } },
        { type: 'insert', entry: { id: 'shared-two', packageId: 'shared-package' } },
      ],
    });
    const generations = join(control, 'plugin-generations-v1');
    assert.equal((await readdir(generations)).length, 1);

    await platform.apply({ operations: [{ type: 'remove', entryId: 'shared-one' }] });
    assert.equal((await readdir(generations)).length, 1);
    assert.equal(platform.composition.inspect('shared-two').status, 'active');

    await platform.apply({ operations: [{ type: 'remove', entryId: 'shared-two' }] });
    await platform.uninstallPackage('shared-package');
    assert.deepEqual(await readdir(generations).catch(() => []), []);
    await platform.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('unknown desired-state commit outcome fences mutation without inventing a rollback', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-plugin-unknown-commit-'));
  try {
    const control = join(root, 'control');
    const store = new UnknownCommitCompositionStore(control);
    const platform = new HostPluginPlatform(control, { store });
    await platform.recover();
    store.fail = true;

    await assert.rejects(
      () => platform.apply({ operations: [{ type: 'insert', entry: { id: 'uncertain-entry' } }] }),
      /commit outcome is unknown/u,
    );
    assert.deepEqual(platform.composition.compositionState().roots.profile, []);
    await assert.rejects(
      () => platform.apply({ operations: [{ type: 'remove', entryId: 'uncertain-entry' }] }),
      /fenced/u,
    );
    await platform.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a queued mutation rechecks the fence after an unknown commit outcome', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-plugin-queued-fence-'));
  try {
    const control = join(root, 'control');
    const store = new DeferredUnknownCompositionStore(control);
    const platform = new HostPluginPlatform(control, { store });
    await platform.recover();
    store.fail = true;

    const first = platform.apply({
      operations: [{ type: 'insert', entry: { id: 'first-uncertain' } }],
    });
    await store.entered;
    const second = platform.apply({
      operations: [{ type: 'insert', entry: { id: 'second-must-not-run' } }],
    });
    store.release();

    await assert.rejects(() => first, /commit outcome is unknown/u);
    await assert.rejects(() => second, /fenced/u);
    assert.deepEqual(platform.desiredComposition().roots.profile, []);
    await platform.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('failed uninstall keeps Package layers and desired state unchanged', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-plugin-uninstall-plan-'));
  try {
    const control = join(root, 'control');
    const platform = new HostPluginPlatform(control);
    await platform.recover();
    await platform.installPackage(
      await writeFixturePackage(root, 'uninstall-plan', 'installed', {
        composition: [
          {
            type: 'insert',
            entry: { id: 'package-default', packageId: 'uninstall-plan' },
          },
        ],
      }),
    );
    await platform.apply({
      operations: [{ type: 'insert', entry: { id: 'user-entry', packageId: 'uninstall-plan' } }],
    });
    const authority = await platform.store.read();
    const desired = platform.desiredComposition();

    await assert.rejects(() => platform.uninstallPackage('uninstall-plan'), /used by desired/u);
    assert.deepEqual(await platform.store.read(), authority);
    assert.deepEqual(platform.desiredComposition(), desired);
    assert.equal(platform.inspect('profile').length, 2);
    await platform.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('composition authority commits before Runtime convergence and exposes divergence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-plugin-divergence-'));
  try {
    const platform = new HostPluginPlatform(join(root, 'control'));
    const coordinator = new HostPluginPlatformCoordinator(platform);
    await platform.recover();
    await platform.installPackage(
      await writeFixturePackage(root, 'failing-package', 'failing', { throwOnApply: true }),
    );

    await assert.rejects(
      () =>
        platform.apply({
          operations: [
            { type: 'insert', entry: { id: 'desired-failure', packageId: 'failing-package' } },
          ],
        }),
      /desired Plugin composition was committed/iu,
    );
    assert.equal(platform.desiredComposition().roots.profile[0]?.id, 'desired-failure');
    assert.deepEqual(platform.composition.compositionState().roots.profile, []);
    const queried = await coordinator.handlers['plugin.platform.query'](
      { view: 'failures' },
      null as never,
    );
    assert.equal(queried.ok, true);
    if (queried.ok && queried.result.view === 'failures') {
      assert.equal(queried.result.items[0]?.entryId, 'desired-failure');
    }
    await platform.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('recovery is fail-open for Host and isolates a broken desired Entry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-plugin-partial-recovery-'));
  try {
    const control = join(root, 'control');
    const initial = new HostPluginPlatform(control);
    await initial.recover();
    await initial.installPackage(await writeFixturePackage(root, 'healthy-package', 'healthy'));
    await initial.close();
    await new HostPluginCompositionStore(control).replace({
      schemaVersion: 1,
      generation: 5,
      packageLayers: [],
      overlays: [
        {
          type: 'insert',
          entry: { id: 'healthy-entry', packageId: 'healthy-package', config: {} },
        },
        {
          type: 'insert',
          entry: { id: 'broken-entry', packageId: 'missing-package', config: {} },
        },
      ],
    });

    const recovered = new HostPluginPlatform(control);
    await recovered.recover();
    assert.equal(recovered.inspect('profile')[0]?.id, 'healthy-entry');
    assert.equal(recovered.desiredComposition().generation, 5);
    assert.deepEqual(
      recovered.desiredComposition().roots.profile.map(({ id }) => id),
      ['healthy-entry', 'broken-entry'],
    );
    assert.equal(
      recovered.failures().some(({ entryId }) => entryId === 'broken-entry'),
      true,
    );
    await recovered.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('corrupt Plugin authority fails closed locally without failing Host recovery', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-plugin-corrupt-authority-'));
  try {
    const control = join(root, 'control');
    await mkdir(control, { recursive: true });
    await writeFile(join(control, 'plugin-composition-v2.json'), '{not-json');
    const platform = new HostPluginPlatform(control);
    const coordinator = new HostPluginPlatformCoordinator(platform);

    await platform.recover();
    const queried = await coordinator.handlers['plugin.platform.query'](
      { view: 'status' },
      null as never,
    );
    assert.equal(queried.ok, false);
    if (!queried.ok) assert.equal(queried.error.code, 'persistence_failed');
    await platform.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a package that fails Runtime loading can still be uninstalled for repair', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-plugin-corrupt-package-removal-'));
  try {
    const control = join(root, 'control');
    const source = await writeFixturePackage(root, 'broken-package', 'broken', {
      runtimePackageId: 'wrong-package',
    });
    await new PluginPackageStore(control).install(source);
    const platform = new HostPluginPlatform(control);
    await platform.recover();
    assert.equal(
      platform.failures().some(({ extensionId }) => extensionId === 'broken-package'),
      true,
    );

    await platform.uninstallPackage('broken-package');
    assert.deepEqual(await platform.packages.identities(), []);
    assert.equal(
      platform.failures().some(({ extensionId }) => extensionId === 'broken-package'),
      false,
    );
    await platform.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Manifest configuration is enforced before desired state is committed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-plugin-config-contract-'));
  try {
    const platform = new HostPluginPlatform(join(root, 'control'));
    await platform.recover();
    await platform.installPackage(
      await writeFixturePackage(root, 'configured-package', 'configured', {
        manifest: {
          configuration: {
            properties: { enabled: { type: 'boolean' } },
            required: ['enabled'],
          },
        },
      }),
    );

    await assert.rejects(
      () =>
        platform.apply({
          operations: [
            { type: 'insert', entry: { id: 'configured-entry', packageId: 'configured-package' } },
          ],
        }),
      (error: unknown) =>
        error instanceof Error &&
        error.cause instanceof Error &&
        /missing required key/u.test(error.cause.message),
    );
    assert.deepEqual(platform.desiredComposition().roots.profile, []);
    assert.deepEqual(platform.composition.compositionState().roots.profile, []);
    await platform.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Manifest configuration defaults are committed to desired and live Entries', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-plugin-config-defaults-'));
  try {
    const platform = new HostPluginPlatform(join(root, 'control'));
    await platform.recover();
    await platform.installPackage(
      await writeFixturePackage(root, 'defaulted-package', 'defaulted', {
        manifest: {
          configuration: {
            properties: { enabled: { type: 'boolean', default: true } },
          },
        },
      }),
    );

    await platform.apply({
      operations: [
        { type: 'insert', entry: { id: 'defaulted-entry', packageId: 'defaulted-package' } },
      ],
    });
    assert.deepEqual(platform.desiredComposition().roots.profile[0]?.config, { enabled: true });
    assert.deepEqual(platform.composition.compositionState().roots.profile[0]?.config, {
      enabled: true,
    });
    await platform.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Manifest dependencies gate activation and protect required packages', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-plugin-package-dependencies-'));
  try {
    const platform = new HostPluginPlatform(join(root, 'control'));
    await platform.recover();
    await platform.installPackage(
      await writeFixturePackage(root, 'dependent-package', 'dependent', {
        manifest: { dependencies: [{ id: 'required-package' }] },
      }),
    );
    await assert.rejects(
      () =>
        platform.apply({
          operations: [
            { type: 'insert', entry: { id: 'dependent-entry', packageId: 'dependent-package' } },
          ],
        }),
      /Plugin composition mutation failed/u,
    );
    assert.deepEqual(platform.desiredComposition().roots.profile, []);

    await platform.installPackage(await writeFixturePackage(root, 'required-package', 'required'));
    await platform.apply({
      operations: [
        { type: 'insert', entry: { id: 'required-entry', packageId: 'required-package' } },
        { type: 'insert', entry: { id: 'dependent-entry', packageId: 'dependent-package' } },
      ],
    });
    await assert.rejects(
      () =>
        platform.apply({
          operations: [{ type: 'remove', entryId: 'required-entry' }],
        }),
      /Plugin composition mutation failed/u,
    );
    await platform.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('package storage recovers every base-generation install and rollback boundary', async () => {
  const cases = [
    {
      name: 'journal synced before publication',
      target: 'old',
      candidate: 'new',
    },
    {
      name: 'previous moved out of target',
      previous: 'old',
      candidate: 'new',
    },
    {
      name: 'candidate published before authority commit',
      target: 'new',
      previous: 'old',
    },
    {
      name: 'rollback rejected the candidate',
      previous: 'old',
      rejected: 'new',
    },
    {
      name: 'rollback restored the previous Package',
      target: 'old',
      rejected: 'new',
    },
    {
      name: 'rollback returned the candidate to staging',
      target: 'old',
      candidate: 'new',
    },
  ] as const;
  for (const state of cases) {
    const root = await mkdtemp(join(tmpdir(), 'maka-plugin-package-recovery-'));
    try {
      const { store, transaction, target } = await writeInstallRecoveryState(root, state);
      await store.recover(7);
      assert.equal(await readPackageMarker(target), 'old', state.name);
      await assert.rejects(() => readdir(transaction), isEnoent, state.name);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test('package storage removes a fresh install at every base-generation boundary', async () => {
  const cases = [
    { name: 'prepared', candidate: 'new' },
    { name: 'published', target: 'new' },
    { name: 'rollback started', rejected: 'new' },
    { name: 'rollback completed', candidate: 'new' },
  ] as const;
  for (const state of cases) {
    const root = await mkdtemp(join(tmpdir(), 'maka-plugin-package-fresh-recovery-'));
    try {
      const { store, transaction, target } = await writeInstallRecoveryState(root, state);
      await store.recover(7);
      await assert.rejects(() => readdir(target), isEnoent, state.name);
      await assert.rejects(() => readdir(transaction), isEnoent, state.name);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test('package storage retains a Package committed by the authority generation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-plugin-package-committed-recovery-'));
  try {
    const { store, transaction, target } = await writeInstallRecoveryState(root, {
      target: 'new',
      previous: 'old',
    });
    await store.recover(8);
    assert.equal(await readPackageMarker(target), 'new');
    await assert.rejects(() => readdir(transaction), isEnoent);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('package storage discards journal-less transaction remnants', async () => {
  const cases = [
    { name: 'abandoned preparation', target: 'old', candidate: 'new' },
    { name: 'partially removed committed transaction', target: 'new', previous: 'old' },
  ] as const;
  for (const state of cases) {
    const root = await mkdtemp(join(tmpdir(), 'maka-plugin-package-journal-less-'));
    try {
      const { store, transaction, target } = await writeInstallRecoveryState(root, state, false);
      await store.recover(state.target === 'new' ? 8 : 7);
      assert.equal(await readPackageMarker(target), state.target, state.name);
      await assert.rejects(() => readdir(transaction), isEnoent, state.name);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test('package storage still fences a corrupt install journal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-plugin-package-corrupt-journal-'));
  try {
    const { store, transaction } = await writeInstallRecoveryState(root, {
      target: 'old',
      candidate: 'new',
    });
    await writeFile(join(transaction, 'transaction.json'), '{invalid');
    await assert.rejects(
      () => store.recover(7),
      /Unable to read Plugin package install transaction/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Plugin Platform close aggregates every resource failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-plugin-close-'));
  try {
    const control = join(root, 'control');
    const packages = new PluginPackageStore(control);
    const composition = new FailingCloseCompositionLoader();
    const packageLoader = new FailingClosePackageLoader(control, packages);
    const platform = new HostPluginPlatform(control, { composition, packages, packageLoader });
    await platform.recover();
    await assert.rejects(
      () => platform.close(),
      (error: unknown) => error instanceof AggregateError && error.errors.length === 2,
    );
    assert.equal(composition.closeAttempted, true);
    assert.equal(packageLoader.closeAttempted, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

interface InstallRecoveryState {
  readonly target?: string;
  readonly candidate?: string;
  readonly previous?: string;
  readonly rejected?: string;
}

async function writeInstallRecoveryState(
  root: string,
  state: InstallRecoveryState,
  journal = true,
): Promise<{
  readonly store: PluginPackageStore;
  readonly transaction: string;
  readonly target: string;
}> {
  const store = new PluginPackageStore(join(root, 'control'));
  const transaction = join(store.root, '.install-owner-death');
  const target = join(store.root, 'recover-package');
  await mkdir(transaction, { recursive: true });
  if (journal) {
    await writeFile(
      join(transaction, 'transaction.json'),
      `${JSON.stringify({
        schemaVersion: 1,
        extensionId: 'recover-package',
        baseGeneration: 7,
        nextGeneration: 8,
      })}\n`,
    );
  }
  for (const name of ['target', 'candidate', 'previous', 'rejected'] as const) {
    const marker = state[name];
    if (marker === undefined) continue;
    const directory = name === 'target' ? target : join(transaction, name);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'marker'), marker);
  }
  return { store, transaction, target };
}

async function readPackageMarker(root: string): Promise<string> {
  return await readFile(join(root, 'marker'), 'utf8');
}

function isEnoent(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

async function writeFixturePackage(
  root: string,
  packageId: string,
  contributionId: string,
  options: {
    readonly runtimePackageId?: string;
    readonly directorySuffix?: string;
    readonly throwOnApply?: boolean;
    readonly manifest?: Readonly<Record<string, unknown>>;
    readonly composition?: readonly unknown[];
  } = {},
): Promise<string> {
  const source = join(
    root,
    `source-${packageId}${options.directorySuffix ? `-${options.directorySuffix}` : ''}`,
  );
  await mkdir(source, { recursive: true });
  await writeFile(
    join(source, 'maka.extension.json'),
    JSON.stringify({
      schemaVersion: 1,
      id: packageId,
      runtime: { entry: 'index.mjs' },
      ...(options.composition ? { composition: { patch: 'maka.composition.yml' } } : {}),
      ...(options.manifest ?? {}),
    }),
  );
  if (options.composition) {
    await writeFile(join(source, 'maka.composition.yml'), JSON.stringify(options.composition));
  }
  await writeFile(
    join(source, 'index.mjs'),
    `export default Object.freeze({
      packageId: ${JSON.stringify(options.runtimePackageId ?? packageId)},
      contributions: Object.freeze([{ id: ${JSON.stringify(contributionId)}, kind: 'foundation-test' }]),
      host: Object.freeze({ apply(ctx) {
        ${options.throwOnApply ? "throw new Error('fixture activation failed');" : ''}
        ctx.effect(() => () => undefined, 'fixture');
      } }),
    });\n`,
  );
  return source;
}

class FailingCompositionStore extends HostPluginCompositionStore {
  fail = false;

  override async replace(state: PersistedPluginComposition): Promise<void> {
    if (this.fail) throw new Error('injected persistence failure');
    await super.replace(state);
  }
}

class UnknownCommitCompositionStore extends HostPluginCompositionStore {
  fail = false;

  override async replace(state: PersistedPluginComposition): Promise<void> {
    if (this.fail) {
      throw new HostPluginCompositionStoreError(
        'commit_outcome_unknown',
        'injected unknown commit outcome',
      );
    }
    await super.replace(state);
  }
}

class AmbiguousCompositionStore extends HostPluginCompositionStore {
  mode: 'before' | 'after' | undefined;

  override async replace(state: PersistedPluginComposition): Promise<void> {
    const mode = this.mode;
    this.mode = undefined;
    if (mode === 'before') {
      throw new HostPluginCompositionStoreError(
        'commit_outcome_unknown',
        'injected unknown commit before authority publication',
      );
    }
    await super.replace(state);
    if (mode === 'after') {
      throw new HostPluginCompositionStoreError(
        'commit_outcome_unknown',
        'injected unknown commit after authority publication',
      );
    }
  }
}

class DeferredUnknownCompositionStore extends HostPluginCompositionStore {
  fail = false;
  readonly entered: Promise<void>;
  readonly #signalEntered: () => void;
  readonly #gate: Promise<void>;
  readonly #release: () => void;

  constructor(controlDirectory: string) {
    super(controlDirectory);
    let signalEntered!: () => void;
    let release!: () => void;
    this.entered = new Promise<void>((resolve) => {
      signalEntered = resolve;
    });
    this.#gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.#signalEntered = signalEntered;
    this.#release = release;
  }

  release(): void {
    this.#release();
  }

  override async replace(state: PersistedPluginComposition): Promise<void> {
    if (!this.fail) return await super.replace(state);
    this.#signalEntered();
    await this.#gate;
    throw new HostPluginCompositionStoreError(
      'commit_outcome_unknown',
      'injected deferred unknown commit outcome',
    );
  }
}

class FailingCloseCompositionLoader extends MakaCompositionLoader {
  closeAttempted = false;

  override async close(): Promise<void> {
    this.closeAttempted = true;
    throw new Error('injected composition close failure');
  }
}

class FailingClosePackageLoader extends TrustedPluginPackageLoader {
  closeAttempted = false;

  override async close(): Promise<void> {
    this.closeAttempted = true;
    throw new Error('injected package loader close failure');
  }
}
