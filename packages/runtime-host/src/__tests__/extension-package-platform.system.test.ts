import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { MakaToolContext } from '@maka/runtime/tool-runtime';
import { HostExtensionController } from '../server/extension-controller.js';
import {
  InstalledPluginPackageLoader,
  StaticTrustedToolExtensionLoader,
} from '../server/extension-loader.js';
import { HostExtensionRuntime, PROFILE_EXTENSION_SCOPE } from '../server/extension-runtime.js';
import { HostPluginCompositionStore } from '../server/plugin-composition-store.js';
import {
  compareExtensionVersions,
  extensionVersionSatisfies,
} from '../server/extension-package-manifest.js';
import { PluginPackageStore } from '../server/plugin-package-store.js';

test('unified Extension package resolves dependencies, configures workers, survives restart, and round-trips a Bundle', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-extension-platform-'));
  const control = join(root, 'control');
  const dependencySource = join(root, 'dependency');
  const applicationSource = join(root, 'application');
  const bundle = join(root, 'application.maka-extension');
  let fixture: ReturnType<typeof createFixture> | undefined;
  try {
    await writeToolPackage(dependencySource, {
      id: 'dev.maka.platform.dependency',
      version: '1.2.0',
      toolName: 'dependency_ping',
      handler: 'ping',
      source: 'export default { ping: () => ({ pong: true }) };\n',
      metadata: {},
    });
    await writeToolPackage(applicationSource, {
      id: 'dev.maka.platform.application',
      version: '2.0.0',
      toolName: 'configured_echo',
      handler: 'echo',
      source: 'export default { echo: (_args, context) => context.configuration };\n',
      metadata: {
        displayName: 'Configured Application',
        description: 'Exercises the unified package contract.',
        dependencies: [{ id: 'dev.maka.platform.dependency', version: '^1.0.0' }],
        configuration: {
          properties: {
            endpoint: { type: 'string', default: 'https://default.invalid' },
            apiKey: { type: 'string', default: 'initial-secret', secret: true },
          },
          required: ['endpoint', 'apiKey'],
        },
      },
    });

    fixture = createFixture(control);
    const dependency = await fixture.loader.installPackage(dependencySource);
    const application = await fixture.loader.installPackage(applicationSource);
    await fixture.controller.recover();
    const enabled = await fixture.controller.handlers['extension.catalog.mutate'](
      {
        kind: 'enable',
        bindingId: 'application-profile',
        scopeId: PROFILE_EXTENSION_SCOPE,
        extensionId: application.extensionId,
        revision: application.revision,
      },
      connection,
    );
    assert.equal(enabled.ok, true);
    const catalog = await fixture.controller.handlers['extension.catalog.query']({}, connection);
    assert.ok(catalog.ok);
    assert.equal(catalog.ok && catalog.result.bindings.length, 2);
    assert.ok(
      catalog.ok &&
        catalog.result.bindings.some(
          (binding) =>
            binding.extensionId === dependency.extensionId && binding.status === 'active',
        ),
    );
    const dependencyBinding = catalog.ok
      ? catalog.result.bindings.find(
          (binding) => binding.extensionId === 'dev.maka.platform.dependency',
        )
      : undefined;
    assert.ok(dependencyBinding);
    const protectedDependency = await fixture.controller.handlers['extension.catalog.mutate'](
      { kind: 'disable', bindingId: dependencyBinding.bindingId },
      connection,
    );
    assert.equal(protectedDependency.ok, false);
    assert.match(
      protectedDependency.ok ? '' : protectedDependency.error.message,
      /required by application-profile/u,
    );
    assert.deepEqual(
      fixture.runtime.composition('session-test').entries.map(({ packageId }) => packageId),
      ['dev.maka.platform.application', 'dev.maka.platform.dependency'],
    );

    const contracts = await fixture.controller.handlers['extension.contract.query']({}, connection);
    assert.ok(contracts.ok);
    const contract = contracts.ok
      ? contracts.result.packages.find(
          (item) => item.extensionId === 'dev.maka.platform.application',
        )
      : undefined;
    assert.equal(contract?.displayName, 'Configured Application');
    assert.deepEqual(contract?.dependencies, [
      { id: 'dev.maka.platform.dependency', version: '^1.0.0' },
    ]);
    assert.deepEqual(
      contract?.contributions.map(({ kind, id }) => ({ kind, id })),
      [{ kind: 'tool', id: 'configured_echo' }],
    );

    const initial = await fixture.controller.handlers['extension.configuration.query'](
      { bindingId: 'application-profile' },
      connection,
    );
    assert.deepEqual(initial, {
      ok: true,
      result: { configuration: { endpoint: 'https://default.invalid' } },
    });
    assert.deepEqual(await invoke(fixture.runtime, 'configured_echo'), {
      endpoint: 'https://default.invalid',
      apiKey: 'initial-secret',
    });

    const configured = await fixture.controller.handlers['extension.configuration.mutate'](
      {
        bindingId: 'application-profile',
        configuration: { endpoint: 'https://api.example', apiKey: 'rotated-secret' },
      },
      connection,
    );
    assert.deepEqual(configured, {
      ok: true,
      result: { configuration: { endpoint: 'https://api.example' } },
    });
    assert.deepEqual(await invoke(fixture.runtime, 'configured_echo'), {
      endpoint: 'https://api.example',
      apiKey: 'rotated-secret',
    });

    const exported = await fixture.controller.handlers['extension.package.export'](
      {
        extensionId: application.extensionId,
        revision: application.revision,
        targetPath: bundle,
      },
      connection,
    );
    assert.deepEqual(exported, { ok: true, result: { targetPath: bundle } });

    await fixture.runtime.close();
    fixture = createFixture(control);
    await fixture.controller.recover();
    assert.deepEqual(await invoke(fixture.runtime, 'configured_echo'), {
      endpoint: 'https://api.example',
      apiKey: 'rotated-secret',
    });

    const disabled = await fixture.controller.handlers['extension.catalog.mutate'](
      { kind: 'disable', bindingId: 'application-profile' },
      connection,
    );
    assert.equal(disabled.ok, true);
    const disabledCatalog = await fixture.controller.handlers['extension.catalog.query'](
      {},
      connection,
    );
    assert.ok(disabledCatalog.ok);
    assert.deepEqual(
      disabledCatalog.ok
        ? disabledCatalog.result.bindings.map(({ extensionId, enabled }) => ({
            extensionId,
            enabled,
          }))
        : [],
      [{ extensionId: 'dev.maka.platform.application', enabled: false }],
    );

    const importedControl = join(root, 'imported-control');
    const imported = createFixture(importedControl);
    try {
      const roundTripped = await imported.loader.installPackage(bundle);
      assert.equal(roundTripped.extensionId, application.extensionId);
      assert.equal(roundTripped.revision, application.revision);
      const importedContracts = await imported.loader.contracts();
      assert.equal(importedContracts[0]?.displayName, 'Configured Application');
    } finally {
      await imported.runtime.close();
    }
  } finally {
    await fixture?.runtime.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

function createFixture(control: string) {
  const runtime = new HostExtensionRuntime();
  const loader = new InstalledPluginPackageLoader(
    new StaticTrustedToolExtensionLoader(),
    new PluginPackageStore(control),
  );
  const controller = new HostExtensionController(
    runtime,
    loader,
    new HostPluginCompositionStore(control),
    () => undefined,
  );
  return { runtime, loader, controller };
}

async function invoke(runtime: HostExtensionRuntime, name: string): Promise<unknown> {
  const tool = runtime
    .resolveTools('session-test', [])
    .find((candidate) => candidate.name === name);
  assert.ok(tool);
  const context: MakaToolContext = {
    sessionId: 'session-test',
    turnId: 'turn-test',
    cwd: tmpdir(),
    toolCallId: 'call-test',
    abortSignal: new AbortController().signal,
    emitOutput: () => undefined,
  };
  return tool.impl({}, context);
}

async function writeToolPackage(
  root: string,
  input: {
    id: string;
    version: string;
    toolName: string;
    handler: string;
    source: string;
    metadata: Record<string, unknown>;
  },
): Promise<void> {
  await mkdir(join(root, 'dist'), { recursive: true });
  await writeFile(
    join(root, 'maka.extension.json'),
    JSON.stringify({
      schemaVersion: 1,
      id: input.id,
      version: input.version,
      ...input.metadata,
      runtime: {
        entry: 'dist/index.mjs',
        tools: [
          {
            name: input.toolName,
            description: input.toolName,
            handler: input.handler,
            inputSchema: { type: 'object', additionalProperties: false },
          },
        ],
        events: [],
        listeners: [],
        services: [],
        timers: [],
        permissions: { workspace: 'none', network: false },
      },
    }),
  );
  await writeFile(join(root, 'dist', 'index.mjs'), input.source);
}

const connection = {
  hostEpoch: 'test',
  connectionId: 'test',
  surface: 'activation' as const,
  principal: 'runtime_host' as const,
  acquireResidency: () => ({ release: () => undefined }),
};

test('Extension dependency ranges follow SemVer-compatible zero-major and numeric ordering', () => {
  assert.equal(extensionVersionSatisfies('1.9.0', '^1.2.0'), true);
  assert.equal(extensionVersionSatisfies('2.0.0', '^1.2.0'), false);
  assert.equal(extensionVersionSatisfies('0.3.9', '^0.3.1'), true);
  assert.equal(extensionVersionSatisfies('0.4.0', '^0.3.1'), false);
  assert.equal(extensionVersionSatisfies('0.0.4', '^0.0.3'), false);
  assert.ok(compareExtensionVersions('1.10.0', '1.9.0') > 0);
});

test('combined package installation rolls back a newly installed Tool when UI persistence fails', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-extension-atomic-install-'));
  const source = join(root, 'source');
  const control = join(root, 'control');
  try {
    await writeToolPackage(source, {
      id: 'dev.maka.platform.combined',
      version: '1.0.0',
      toolName: 'combined_ping',
      handler: 'ping',
      source: 'export default { ping: () => ({ pong: true }) };\n',
      metadata: {
        ui: {
          contributions: [
            {
              id: 'combined-root',
              surface: 'app.root',
              priority: 0,
              document: 'documents/root.html',
            },
          ],
          permissions: { network: false },
        },
      },
    });
    await mkdir(join(source, 'documents'), { recursive: true });
    await writeFile(
      join(source, 'documents', 'root.html'),
      '<!doctype html><title>Combined</title>',
    );
    const toolStore = new RejectingPluginPackageStore(control);
    const loader = new InstalledPluginPackageLoader(
      new StaticTrustedToolExtensionLoader(),
      toolStore,
    );
    await assert.rejects(
      () => loader.installPackage(source),
      /Extension package operation failed/u,
    );
    assert.deepEqual(await new PluginPackageStore(control).list(), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

class RejectingPluginPackageStore extends PluginPackageStore {
  override async install(): Promise<never> {
    throw new Error('simulated UI persistence failure');
  }
}
