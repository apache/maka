import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { MakaTool } from '@maka/runtime/tool-runtime';
import { HostExtensionController } from '../server/extension-controller.js';
import {
  InstalledToolPackageExtensionLoader,
  StaticTrustedToolExtensionLoader,
} from '../server/extension-loader.js';
import { HostExtensionRuntime } from '../server/extension-runtime.js';
import { HostExtensionStateStore } from '../server/extension-state-store.js';
import { ToolPackageStore } from '../server/tool-package-store.js';
import {
  DESKTOP_UI_EXTENSION_SCOPE,
  HostUiPackageManagementTools,
} from '../server/ui-package-management-tools.js';
import { UiPackageStore } from '../server/ui-package-store.js';

test('agent-authored client-only UI survives update, rollback boundary, and Host restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-ui-package-'));
  try {
    let fixture = await createFixture(root);
    const v1 = (await call(fixture.tools, 'define_ui', {
      id: 'dev.maka.ui.demo',
      version: '1',
      ui: [{ id: 'demo-root', surface: 'app.root', priority: 200, document: '<h1>one</h1>' }],
      permissions: { network: false },
    })) as { revision: string; uiContributionIds: string[]; toolNames: string[] };
    assert.deepEqual(v1.uiContributionIds, ['demo-root']);
    assert.deepEqual(v1.toolNames, []);
    const tested = (await call(fixture.tools, 'test_ui', {
      extensionId: 'dev.maka.ui.demo',
      revision: v1.revision,
    })) as { ok: boolean; contributions: Array<{ document: string }> };
    assert.equal(tested.ok, true);
    assert.equal(tested.contributions[0]?.document, '<h1>one</h1>');
    await call(fixture.tools, 'manage_ui', {
      action: 'activate',
      extensionId: 'dev.maka.ui.demo',
      revision: v1.revision,
    });
    assert.equal(
      fixture.runtime.inspectUi(DESKTOP_UI_EXTENSION_SCOPE)[0]?.document,
      '<h1>one</h1>',
    );

    const v2 = (await call(fixture.tools, 'define_ui', {
      id: 'dev.maka.ui.demo',
      version: '2',
      ui: [{ id: 'demo-root', surface: 'app.root', priority: 200, document: '<h1>two</h1>' }],
      permissions: { network: false },
    })) as { revision: string };
    await call(fixture.tools, 'manage_ui', {
      action: 'update',
      extensionId: 'dev.maka.ui.demo',
      revision: v2.revision,
    });
    const snapshot = await fixture.controller.handlers['extension.ui.snapshot'](
      { scopeId: DESKTOP_UI_EXTENSION_SCOPE },
      connection,
    );
    assert.equal(snapshot.ok && snapshot.result.contributions[0]?.document, '<h1>two</h1>');
    const digest = snapshot.ok && snapshot.result.digest;

    await fixture.runtime.close();
    fixture = await createFixture(root);
    await fixture.controller.recover();
    const recovered = await fixture.controller.handlers['extension.ui.snapshot'](
      { scopeId: DESKTOP_UI_EXTENSION_SCOPE },
      connection,
    );
    assert.equal(recovered.ok && recovered.result.contributions[0]?.document, '<h1>two</h1>');
    assert.equal(recovered.ok && recovered.result.digest, digest);
    await call(fixture.tools, 'manage_ui', { action: 'stop', extensionId: 'dev.maka.ui.demo' });
    assert.deepEqual(fixture.runtime.inspectUi(DESKTOP_UI_EXTENSION_SCOPE), []);
    await fixture.runtime.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('UI package Store rejects symlinks and detects installed content corruption', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-ui-store-'));
  try {
    const source = join(root, 'source');
    await mkdir(join(source, 'documents'), { recursive: true });
    await writeFile(
      join(source, 'maka.ui.json'),
      JSON.stringify({
        schemaVersion: 1,
        id: 'dev.maka.ui.integrity',
        version: '1',
        ui: [{ id: 'root', surface: 'app.root', priority: 1, document: 'documents/root.html' }],
        permissions: { network: false },
      }),
    );
    await writeFile(join(source, 'documents', 'root.html'), '<main>safe</main>');
    const store = new UiPackageStore(join(root, 'control'));
    const installed = await store.install(source);
    await writeFile(join(installed.root, 'documents', 'root.html'), '<main>changed</main>');
    await assert.rejects(
      store.load(installed.extensionId, installed.revision),
      /integrity check failed/,
    );

    const linked = join(root, 'linked');
    await mkdir(linked);
    await writeFile(join(linked, 'maka.ui.json'), '{}');
    await symlink(join(source, 'documents', 'root.html'), join(linked, 'root.html'));
    await assert.rejects(store.install(linked), /may not contain symlinks/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

const connection = {
  hostEpoch: 'test',
  connectionId: 'test',
  surface: 'activation' as const,
  principal: 'runtime_host' as const,
  acquireResidency: () => ({ release: () => undefined }),
};

async function createFixture(root: string) {
  const runtime = new HostExtensionRuntime();
  const uiStore = new UiPackageStore(root);
  const controller = new HostExtensionController(
    runtime,
    new InstalledToolPackageExtensionLoader(
      new StaticTrustedToolExtensionLoader(),
      new ToolPackageStore(root),
      uiStore,
    ),
    new HostExtensionStateStore(root),
    () => undefined,
  );
  await controller.recover();
  const tools = new HostUiPackageManagementTools(root, controller, runtime, uiStore).tools();
  return { runtime, controller, tools };
}

async function call(tools: readonly MakaTool[], name: string, input: unknown): Promise<unknown> {
  const tool = tools.find((item) => item.name === name);
  assert.ok(tool, `missing ${name}`);
  return tool.impl(input, {} as never);
}
