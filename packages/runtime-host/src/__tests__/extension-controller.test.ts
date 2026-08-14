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
import { HostExtensionStateStore } from '../server/extension-state-store.js';
import type { ConnectionContext } from '../server/operation-dispatcher.js';

const connection: ConnectionContext = {
  hostEpoch: 'extension-controller-test',
  connectionId: 'local-owner',
  surface: 'desktop',
  principal: 'local_os_user',
  acquireResidency: () => ({ release: () => undefined }),
};

test('Extension control plane enables, upgrades, restores last-good, disables, and restarts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-extension-control-'));
  const loader = new StaticTrustedToolExtensionLoader([
    revision('1'),
    revision('2'),
    revision('3', async () => {
      throw new Error('weather v3 is unhealthy');
    }),
  ]);
  const store = new HostExtensionStateStore(root);
  let runtime = new HostExtensionRuntime();
  let controller = new HostExtensionController(runtime, loader, store, () =>
    assert.fail('deterministic Extension failures must not drain the Host'),
  );

  try {
    await controller.recover();
    const initial = await controller.handlers['extension.catalog.query']({}, connection);
    assert.equal(initial.ok, true);
    assert.deepEqual(initial.ok && initial.result.revisions.map(({ revision: item }) => item), [
      '1',
      '2',
      '3',
    ]);

    const enabled = await controller.handlers['extension.catalog.mutate'](
      {
        kind: 'enable',
        bindingId: 'weather-binding',
        scopeId: 'session-1',
        extensionId: 'weather',
        revision: '1',
      },
      connection,
    );
    assert.equal(enabled.ok, true);
    assert.deepEqual(enabled.ok && enabled.result.binding, {
      bindingId: 'weather-binding',
      scopeId: 'session-1',
      extensionId: 'weather',
      desiredRevision: '1',
      lastGoodRevision: '1',
      enabled: true,
      status: 'active',
      error: null,
    });
    assert.equal(await invoke(runtime, 'session-1'), '1');

    const upgraded = await controller.handlers['extension.catalog.mutate'](
      { kind: 'update', bindingId: 'weather-binding', revision: '2' },
      connection,
    );
    assert.equal(upgraded.ok, true);
    assert.equal(upgraded.ok && upgraded.result.binding?.lastGoodRevision, '2');
    assert.equal(await invoke(runtime, 'session-1'), '2');
    assert.deepEqual(runtime.installedRevisions(), [{ extensionId: 'weather', revision: '2' }]);

    const failed = await controller.handlers['extension.catalog.mutate'](
      { kind: 'update', bindingId: 'weather-binding', revision: '3' },
      connection,
    );
    assert.deepEqual(failed.ok, false);
    assert.equal(!failed.ok && failed.error.code, 'operation_conflict');
    assert.match(!failed.ok ? failed.error.message : '', /health_check failed/);
    assert.equal(await invoke(runtime, 'session-1'), '2');

    const afterFailure = await controller.handlers['extension.catalog.query']({}, connection);
    assert.equal(afterFailure.ok, true);
    assert.deepEqual(afterFailure.ok && afterFailure.result.bindings[0], {
      bindingId: 'weather-binding',
      scopeId: 'session-1',
      extensionId: 'weather',
      desiredRevision: '3',
      lastGoodRevision: '2',
      enabled: true,
      status: 'failed',
      error: 'Extension candidate weather@3 health_check failed',
    });

    await runtime.close();
    runtime = new HostExtensionRuntime();
    controller = new HostExtensionController(runtime, loader, store, () =>
      assert.fail('last-good recovery must not drain the Host'),
    );
    await controller.recover();
    assert.equal(await invoke(runtime, 'session-1'), '2');
    const recovered = await controller.handlers['extension.catalog.query']({}, connection);
    assert.equal(recovered.ok, true);
    assert.equal(recovered.ok && recovered.result.bindings[0]?.desiredRevision, '3');
    assert.equal(recovered.ok && recovered.result.bindings[0]?.lastGoodRevision, '2');
    assert.equal(recovered.ok && recovered.result.bindings[0]?.status, 'failed');

    const disabled = await controller.handlers['extension.catalog.mutate'](
      { kind: 'disable', bindingId: 'weather-binding' },
      connection,
    );
    assert.equal(disabled.ok, true);
    assert.equal(disabled.ok && disabled.result.binding?.status, 'disabled');
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
      bindings: Array<{ enabled: boolean; lastGoodRevision: string }>;
    };
    assert.equal(persisted.bindings[0]?.enabled, false);
    assert.equal(persisted.bindings[0]?.lastGoodRevision, '2');

    const removed = await controller.handlers['extension.catalog.mutate'](
      { kind: 'remove', bindingId: 'weather-binding' },
      connection,
    );
    assert.deepEqual(removed, { ok: true, result: { binding: null } });
    assert.deepEqual(runtime.installedRevisions(), []);
    assert.deepEqual(JSON.parse(await readFile(store.path, 'utf8')) as { bindings: unknown[] }, {
      schemaVersion: 1,
      bindings: [],
    });
  } finally {
    await runtime.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test('Extension recovery isolates corrupt state from normal Runtime Host startup', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-extension-corrupt-'));
  const store = new HostExtensionStateStore(root);
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
    assert.deepEqual(await controller.handlers['extension.catalog.query']({}, connection), {
      ok: false,
      error: { code: 'persistence_failed', message: 'Extension state is unavailable' },
    });
    assert.deepEqual(runtime.resolveTools('session-1', []), []);
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
