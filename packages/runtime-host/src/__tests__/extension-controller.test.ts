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
  const loader = new StaticTrustedToolExtensionLoader([
    revision('1'),
    revision('2'),
    revision('3', async () => {
      throw new Error('weather v3 is unhealthy');
    }),
  ]);
  const store = new HostPluginCompositionStore(root);
  let runtime = new HostExtensionRuntime();
  let controller = new HostExtensionController(runtime, loader, store, () =>
    assert.fail('deterministic Extension failures must not drain the Host'),
  );

  try {
    await controller.recover();
    const initial = await controller.handlers['extension.composition.query']({}, connection);
    assert.equal(initial.ok, true);
    assert.deepEqual(initial.ok && initial.result.revisions.map(({ revision: item }) => item), [
      '1',
      '2',
      '3',
    ]);

    const enabled = await controller.handlers['extension.composition.mutate'](
      {
        kind: 'enable',
        entryId: 'weather-entry',
        scopeId: 'session-1',
        extensionId: 'weather',
        revision: '1',
      },
      connection,
    );
    assert.equal(enabled.ok, true);
    assert.deepEqual(enabled.ok && enabled.result.entry, {
      entryId: 'weather-entry',
      scopeId: 'session-1',
      extensionId: 'weather',
      revision: '1',
      enabled: true,
      status: 'active',
      error: null,
    });
    assert.equal(await invoke(runtime, 'session-1'), '1');

    const upgraded = await controller.handlers['extension.composition.mutate'](
      { kind: 'update', entryId: 'weather-entry', revision: '2' },
      connection,
    );
    assert.equal(upgraded.ok, true);
    assert.equal(await invoke(runtime, 'session-1'), '2');
    assert.deepEqual(runtime.installedRevisions(), [{ extensionId: 'weather', revision: '2' }]);

    const failed = await controller.handlers['extension.composition.mutate'](
      { kind: 'update', entryId: 'weather-entry', revision: '3' },
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
      revision: '3',
      enabled: true,
      status: 'failed',
      error: 'Unable to activate entry weather-entry: weather v3 is unhealthy',
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
    assert.equal(recovered.ok && recovered.result.entries[0]?.revision, '3');
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
    assert.deepEqual(runtime.installedRevisions(), []);

    const persisted = JSON.parse(await readFile(store.path, 'utf8')) as {
      roots: { sessions: Record<string, Array<{ disabled: boolean; revision: string }>> };
    };
    assert.equal(persisted.roots.sessions['session-1']?.[0]?.disabled, true);
    assert.equal(persisted.roots.sessions['session-1']?.[0]?.revision, '3');

    const removed = await controller.handlers['extension.composition.mutate'](
      { kind: 'remove', entryId: 'weather-entry' },
      connection,
    );
    assert.deepEqual(removed, { ok: true, result: { entry: null } });
    assert.deepEqual(runtime.installedRevisions(), []);
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
                revision: '1',
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
    new StaticTrustedToolExtensionLoader([revision('1'), revision('2')]),
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
    const updated = await controller.handlers['extension.composition.mutate'](
      { kind: 'update', entryId: 'weather-entry', revision: '2' },
      connection,
    );
    assert.equal(updated.ok, true);
    assert.equal(await invoke(runtime, 'session-1'), '2');
    const persisted = await store.read();
    assert.equal(persisted?.roots.sessions['session-1']?.[0]?.children?.[0]?.id, 'weather-entry');
    assert.equal(persisted?.roots.sessions['session-1']?.[0]?.children?.[0]?.revision, '2');
    assert.deepEqual(persisted?.roots.sessions['session-1']?.[0]?.intercept, { locale: 'zh-CN' });
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
  revision: string;
  tools: readonly MakaTool[];
  healthCheck?: () => void | Promise<void>;
} {
  return {
    extensionId: 'weather',
    revision: value,
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
