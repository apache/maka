import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { IpcHandler } from '../ipc-reconnect-policy.js';
import type { DesktopRuntimeHostClient } from '../runtime-host-client.js';
import { registerRuntimeHostUiExtensionsIpc } from '../runtime-host-ui-extensions-ipc-main.js';

test('user import previews, confirms, installs, and enables one UI, Hook, and Event package', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-ui-import-'));
  try {
    await mkdir(join(root, 'documents'));
    await mkdir(join(root, 'host'));
    await mkdir(join(root, 'dist'));
    await writeFile(join(root, 'maka.ui.json'), JSON.stringify({
      schemaVersion: 1,
      id: 'dev.maka.user.ui',
      version: '1',
      ui: [{ id: 'root', surface: 'app.root', priority: 1, document: 'documents/root.html' }],
      host: { entry: 'host/service.mjs', methods: [{ name: 'hello', handler: 'hello' }] },
      permissions: { network: false, hostState: true, sessionAccess: true },
    }));
    await writeFile(join(root, 'documents', 'root.html'), '<main>hello</main>');
    await writeFile(join(root, 'host', 'service.mjs'), 'export default { hello: () => "world" };');
    await writeFile(
      join(root, 'maka.hook.json'),
      JSON.stringify({
        schemaVersion: 1,
        id: 'dev.maka.user.ui',
        version: '1',
        entry: 'dist/index.mjs',
        hooks: [
          {
            id: 'policy',
            event: 'PreToolUse',
            mode: 'gate',
            handler: 'policy',
          },
        ],
        permissions: { workspace: 'none', network: false },
      }),
    );
    await writeFile(
      join(root, 'dist', 'index.mjs'),
      'export default { policy: () => ({ decision: "allow" }) };',
    );
    await writeFile(
      join(root, 'maka.event.json'),
      JSON.stringify({
        schemaVersion: 1,
        id: 'dev.maka.user.ui',
        version: '1',
        entry: 'dist/index.mjs',
        events: [
          {
            name: 'dev.maka.user.ui.changed',
            description: 'UI changed.',
            payloadSchema: { type: 'object' },
          },
        ],
        listeners: [],
        permissions: { workspace: 'none', network: false },
      }),
    );
    const handlers = new Map<string, IpcHandler>();
    const requests: Array<{ operation: string; input: unknown }> = [];
    const client = {
      request: async (operation: string, input: unknown) => {
        requests.push({ operation, input });
        if (operation === 'extension.package.install') {
          return { extensionId: 'dev.maka.user.ui', revision: 'sha256-demo', toolNames: [], uiContributionIds: ['root'], hookContributionIds: ['PreToolUse:policy'], eventContributionIds: ['event:dev.maka.user.ui.changed'] };
        }
        if (operation === 'extension.catalog.query') return { revisions: [], bindings: [] };
        if (operation === 'extension.catalog.mutate') return { binding: null };
        throw new Error(`unexpected ${operation}`);
      },
    } as unknown as DesktopRuntimeHostClient;
    registerRuntimeHostUiExtensionsIpc({
      ipcMain: {
        handle: (channel, listener) => handlers.set(channel, listener),
        handleReconnectableRead: (channel, listener) => handlers.set(channel, listener),
      },
      client,
      mainWindowController: {
        showOpenDialog: async () => ({ canceled: false, filePaths: [root] }),
        showMessageBox: async () => ({ response: 0, checkboxChecked: false }),
      } as never,
      allowLocalPaths: true,
    });
    const handler = handlers.get('ui-extensions:importLocal');
    assert.ok(handler);
    assert.deepEqual(await handler({} as never), { ok: true, extensionId: 'dev.maka.user.ui', revision: 'sha256-demo' });
    assert.equal(requests[0]?.operation, 'extension.package.install');
    const mutations = requests.filter(({ operation }) => operation === 'extension.catalog.mutate');
    assert.equal(mutations.length, 2);
    assert.deepEqual(mutations[0], {
      operation: 'extension.catalog.mutate',
      input: {
        kind: 'enable',
        bindingId: mutations[0] && (mutations[0].input as { bindingId: string }).bindingId,
        scopeId: 'desktop-ui',
        extensionId: 'dev.maka.user.ui',
        revision: 'sha256-demo',
      },
    });
    assert.equal((mutations[1]?.input as { scopeId?: string } | undefined)?.scopeId, 'profile');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
