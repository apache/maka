import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  resolveStorageRoot,
  tryAcquireInteractiveRootOwner,
  type InteractiveRootOwner,
} from '@maka/storage/root-authority';
import { z } from 'zod';
import { createExecutionRuntimeHostComposition } from '../server/execution-composition.js';
import type { ConnectionContext } from '../server/operation-dispatcher.js';

const connection: ConnectionContext = {
  hostEpoch: 'extension-composition-test',
  connectionId: 'local-owner',
  surface: 'desktop',
  principal: 'local_os_user',
  acquireResidency: () => ({ release: () => undefined }),
};

test('production composition exposes trusted Extension control and restores it after restart', async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-extension-composition-'));
  const root = join(base, 'interactive');
  const capability = await resolveStorageRoot({ path: root, kind: 'interactive' });
  let owner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(owner);
  if (!owner) return;
  const trustedToolExtensions = [
    {
      extensionId: 'weather',
      revision: '1',
      tools: [
        {
          name: 'Weather',
          description: 'Read the deterministic weather fixture',
          parameters: z.object({}),
          impl: async () => ({ forecast: 'sunny' }),
        },
      ],
    },
  ];
  let composition: Awaited<ReturnType<typeof createExecutionRuntimeHostComposition>> | undefined;
  try {
    composition = await createExecutionRuntimeHostComposition(compositionContext(owner), {
      trustedToolExtensions,
    });
    await composition.recover();
    const enabled = await composition.handlers['extension.composition.mutate'](
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
    assert.deepEqual(
      composition.extensions.resolveTools('session-1', []).map(({ name }) => name),
      [
        'Weather',
        'call_service',
        'define_package',
        'emit_event',
        'inspect_package',
        'invoke_tool',
        'manage_package',
        'publish_ui_state',
      ],
    );

    await composition.close();
    composition = undefined;
    await owner.close();
    owner = await tryAcquireInteractiveRootOwner(
      await resolveStorageRoot({ path: root, kind: 'interactive' }),
    );
    assert.ok(owner);
    if (!owner) return;

    composition = await createExecutionRuntimeHostComposition(compositionContext(owner), {
      trustedToolExtensions,
    });
    await composition.recover();
    const restored = await composition.handlers['extension.composition.query']({}, connection);
    assert.equal(restored.ok, true);
    assert.equal(restored.ok && restored.result.entries[0]?.status, 'active');
    assert.deepEqual(
      composition.extensions.resolveTools('session-1', []).map(({ name }) => name),
      [
        'Weather',
        'call_service',
        'define_package',
        'emit_event',
        'inspect_package',
        'invoke_tool',
        'manage_package',
        'publish_ui_state',
      ],
    );
  } finally {
    await composition?.close().catch(() => undefined);
    if (owner && !owner.closed) await owner.close();
    await rm(base, { recursive: true, force: true });
  }
});

function compositionContext(owner: InteractiveRootOwner) {
  return {
    owner,
    hostEpoch: 'extension-composition-test',
    acquireResidency: () => ({ release() {} }),
    retainUntilProcessExit: () => undefined,
    requestDrain: () => undefined,
  };
}
