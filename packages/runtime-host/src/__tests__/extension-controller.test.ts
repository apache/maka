import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { MakaTool } from '@maka/runtime/tool-runtime';
import { z } from 'zod';
import { HostExtensionController } from '../server/extension-controller.js';
import { StaticTrustedToolExtensionLoader } from '../server/extension-loader.js';
import { HostExtensionRuntime } from '../server/extension-runtime.js';
import { HostPluginCompositionStore } from '../server/plugin-composition-store.js';
import type { ConnectionContext } from '../server/operation-dispatcher.js';

const connection: ConnectionContext = {
  hostEpoch: 'extension-controller-test',
  connectionId: 'local-owner',
  surface: 'desktop',
  principal: 'local_os_user',
  acquireResidency: () => ({ release: () => undefined }),
};

test('Extension composition enables, upgrades, rejects failed replacement, and restarts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-extension-control-'));
  let current = revision('1');
  const loader = mutableLoader(() => current);
  const store = new HostPluginCompositionStore(root);
  let runtime = new HostExtensionRuntime();
  let controller = new HostExtensionController(runtime, loader, store, () =>
    assert.fail('deterministic Extension failures must not drain the Host'),
  );

  try {
    await controller.recover();
    const initial = await controller.handlers['extension.composition.query']({}, connection);
    assert.equal(initial.ok, true);
    assert.deepEqual(
      initial.ok && initial.result.extensions.map(({ extensionId }) => extensionId),
      ['weather'],
    );

    const enabled = await controller.handlers['extension.composition.mutate'](
      {
        kind: 'enable',
        entryId: 'weather-entry',
        scopeId: 'session-1',
        extensionId: 'weather',
      },
      connection,
    );
    assert.equal(enabled.ok, true);
    assert.deepEqual(enabled.ok && enabled.result.entry, {
      entryId: 'weather-entry',
      scopeId: 'session-1',
      extensionId: 'weather',
      generation: 1,
      enabled: true,
      status: 'active',
      error: null,
    });
    assert.equal(await invoke(runtime, 'session-1'), '1');

    current = revision('2');
    const upgraded = await controller.handlers['extension.composition.mutate'](
      { kind: 'reload', entryId: 'weather-entry' },
      connection,
    );
    assert.equal(upgraded.ok, true);
    assert.equal(await invoke(runtime, 'session-1'), '2');
    assert.deepEqual(runtime.installedExtensions(), [{ extensionId: 'weather' }]);

    current = revision('3', async () => {
      throw new Error('weather v3 is unhealthy');
    });
    const failed = await controller.handlers['extension.composition.mutate'](
      { kind: 'reload', entryId: 'weather-entry' },
      connection,
    );
    assert.deepEqual(failed.ok, false);
    assert.equal(!failed.ok && failed.error.code, 'operation_conflict');
    assert.match(!failed.ok ? failed.error.message : '', /weather v3 is unhealthy/);
    assert.equal(await invoke(runtime, 'session-1'), '2');

    const afterFailure = await controller.handlers['extension.composition.query']({}, connection);
    assert.equal(afterFailure.ok, true);
    assert.deepEqual(afterFailure.ok && afterFailure.result.entries[0], {
      entryId: 'weather-entry',
      scopeId: 'session-1',
      extensionId: 'weather',
      generation: 2,
      enabled: true,
      status: 'active',
      error: null,
    });

    await runtime.close();
    runtime = new HostExtensionRuntime();
    controller = new HostExtensionController(runtime, loader, store, () =>
      assert.fail('failed composition recovery must not drain the Host'),
    );
    await controller.recover();
    assert.deepEqual(runtime.resolveTools('session-1', []), []);
    const recovered = await controller.handlers['extension.composition.query']({}, connection);
    assert.equal(recovered.ok, true);
    assert.equal(recovered.ok && recovered.result.entries[0]?.status, 'failed');

    const disabled = await controller.handlers['extension.composition.mutate'](
      { kind: 'disable', entryId: 'weather-entry' },
      connection,
    );
    assert.equal(disabled.ok, true);
    assert.equal(disabled.ok && disabled.result.entry?.status, 'disabled');
    assert.deepEqual(runtime.resolveTools('session-1', []), []);

    await runtime.close();
    runtime = new HostExtensionRuntime();
    controller = new HostExtensionController(runtime, loader, store, () =>
      assert.fail('disabled recovery must not drain the Host'),
    );
    await controller.recover();
    assert.deepEqual(runtime.resolveTools('session-1', []), []);
    assert.deepEqual(runtime.installedExtensions(), []);

    const persisted = JSON.parse(await readFile(store.path, 'utf8')) as {
      roots: { sessions: Record<string, Array<{ disabled: boolean }>> };
    };
    assert.equal(persisted.roots.sessions['session-1']?.[0]?.disabled, true);

    const removed = await controller.handlers['extension.composition.mutate'](
      { kind: 'remove', entryId: 'weather-entry' },
      connection,
    );
    assert.deepEqual(removed, { ok: true, result: { entry: null } });
    assert.deepEqual(runtime.installedExtensions(), []);
    const empty = JSON.parse(await readFile(store.path, 'utf8')) as {
      roots: { sessions: Record<string, unknown[]> };
    };
    assert.deepEqual(empty.roots.sessions['session-1'], []);
  } finally {
    await runtime.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test('Extension recovery isolates corrupt state from normal Runtime Host startup', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-extension-corrupt-'));
  const store = new HostPluginCompositionStore(root);
  const runtime = new HostExtensionRuntime();
  const controller = new HostExtensionController(
    runtime,
    new StaticTrustedToolExtensionLoader([revision('1')]),
    store,
    () => undefined,
  );
  try {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(store.path, '{not-json', 'utf8');
    await controller.recover();
    assert.deepEqual(await controller.handlers['extension.composition.query']({}, connection), {
      ok: false,
      error: { code: 'persistence_failed', message: 'Extension state is unavailable' },
    });
    assert.deepEqual(runtime.resolveTools('session-1', []), []);
  } finally {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('Composition Snapshot restores and preserves nested groups', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-extension-tree-'));
  const store = new HostPluginCompositionStore(root);
  await store.replace({
    schemaVersion: 1,
    generation: 7,
    roots: {
      profile: [],
      desktopUi: [],
      sessions: {
        'session-1': [
          {
            id: 'workspace-group',
            disabled: false,
            config: {},
            intercept: { locale: 'zh-CN' },
            children: [
              {
                id: 'weather-entry',
                packageId: 'weather',
                disabled: false,
                config: {},
                error: null,
              },
            ],
          },
        ],
      },
    },
  });
  const runtime = new HostExtensionRuntime();
  const controller = new HostExtensionController(
    runtime,
    new StaticTrustedToolExtensionLoader([revision('1')]),
    store,
    () => assert.fail('tree recovery must not drain the Host'),
  );
  try {
    await controller.recover();
    assert.deepEqual(
      runtime.inspectRuntime().map(({ id, children }) => [id, children[0]?.id]),
      [['workspace-group', 'weather-entry']],
    );
    assert.equal(await invoke(runtime, 'session-1'), '1');
    const persisted = await store.read();
    assert.equal(persisted?.roots.sessions['session-1']?.[0]?.children?.[0]?.id, 'weather-entry');
    assert.deepEqual(persisted?.roots.sessions['session-1']?.[0]?.intercept, { locale: 'zh-CN' });
  } finally {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('Composition allows repeated instances of one Extension in a scope', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-extension-repeated-'));
  const store = new HostPluginCompositionStore(root);
  const runtime = new HostExtensionRuntime();
  const loader = {
    list: async () => [
      {
        extensionId: 'repeated-extension',
        toolNames: ['per-entry'],
        uiContributionIds: [],
        eventContributionIds: [],
        serviceContributionIds: [],
        timerContributionIds: [],
      },
    ],
    load: async () => ({
      extensionId: 'repeated-extension',
      toolNames: ['per-entry'],
      load: async (context: { readonly entryId: string }) => ({
        tools: [
          {
            name: `Tool_${context.entryId}`,
            description: 'Entry-owned Tool',
            parameters: z.object({}),
            impl: async () => context.entryId,
          },
        ],
      }),
    }),
    contracts: async () => [
      {
        extensionId: 'repeated-extension',
        displayName: 'Repeated Extension',
        description: '',
        dependencies: [],
        configuration: { properties: {}, required: [] },
        contributions: [],
      },
    ],
  };
  const controller = new HostExtensionController(runtime, loader, store, () =>
    assert.fail('repeated Extension entries must not drain the Host'),
  );
  try {
    await controller.recover();
    for (const entryId of ['empty-first', 'empty-second']) {
      const enabled = await controller.handlers['extension.composition.mutate'](
        {
          kind: 'enable',
          entryId,
          scopeId: 'session-1',
          extensionId: 'repeated-extension',
        },
        connection,
      );
      assert.equal(enabled.ok, true);
    }
    const queried = await controller.handlers['extension.composition.query']({}, connection);
    assert.equal(queried.ok, true);
    assert.deepEqual(queried.ok && queried.result.entries.map(({ entryId }) => entryId), [
      'empty-first',
      'empty-second',
    ]);
    assert.equal(runtime.inspect('empty-first').status, 'active');
    assert.equal(runtime.inspect('empty-second').status, 'active');
  } finally {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

function revision(
  value: string,
  healthCheck?: () => void | Promise<void>,
): {
  extensionId: string;
  tools: readonly MakaTool[];
  healthCheck?: () => void | Promise<void>;
} {
  return {
    extensionId: 'weather',
    tools: [
      {
        name: 'Weather',
        description: `Weather revision ${value}`,
        parameters: z.object({}),
        impl: async () => ({ revision: value }),
      },
    ],
    ...(healthCheck ? { healthCheck } : {}),
  };
}

function mutableLoader(current: () => ReturnType<typeof revision>) {
  return {
    list: async () => [
      {
        extensionId: 'weather',
        toolNames: ['Weather'],
        uiContributionIds: [],
        eventContributionIds: [],
      },
    ],
    load: async () => current(),
    contracts: async () => [
      {
        extensionId: 'weather',
        displayName: 'weather',
        description: '',
        dependencies: [],
        configuration: { properties: {}, required: [] },
        contributions: [],
      },
    ],
  };
}

async function invoke(runtime: HostExtensionRuntime, scopeId: string): Promise<string> {
  const tool = runtime.resolveTools(scopeId, []).find(({ name }) => name === 'Weather');
  assert.ok(tool);
  const result = (await tool.impl(
    {},
    {
      sessionId: scopeId,
      turnId: 'turn-1',
      cwd: '/workspace',
      toolCallId: 'tool-call-1',
      abortSignal: new AbortController().signal,
      emitOutput: () => undefined,
      askUserQuestion: async () => ({ answers: [] }),
    },
  )) as { revision: string };
  return result.revision;
}
