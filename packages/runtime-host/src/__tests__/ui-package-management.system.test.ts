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
import { HostExtensionUiStateStore } from '../server/extension-ui-state-store.js';
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
      permissions: { network: false, hostState: true },
      host: {
        source:
          'export default { add: (args) => ({ total: Number(args.left) + Number(args.right) }) };',
        methods: [{ name: 'add', handler: 'add' }],
      },
    })) as { revision: string; uiContributionIds: string[]; toolNames: string[] };
    assert.deepEqual(v1.uiContributionIds, ['demo-root']);
    assert.deepEqual(v1.toolNames, []);
    const tested = (await call(fixture.tools, 'test_ui', {
      extensionId: 'dev.maka.ui.demo',
      revision: v1.revision,
    })) as { ok: boolean; contributions: Array<{ document: string; hostMethods: string[] }> };
    assert.equal(tested.ok, true);
    assert.equal(tested.contributions[0]?.document, '<h1>one</h1>');
    assert.deepEqual(tested.contributions[0]?.hostMethods, ['add']);
    await call(fixture.tools, 'manage_ui', {
      action: 'activate',
      extensionId: 'dev.maka.ui.demo',
      revision: v1.revision,
    });
    assert.equal(
      fixture.runtime.inspectUi(DESKTOP_UI_EXTENSION_SCOPE)[0]?.document,
      '<h1>one</h1>',
    );
    const active = fixture.runtime.inspectUi(DESKTOP_UI_EXTENSION_SCOPE)[0]!;
    const stateIdentity = {
      scopeId: DESKTOP_UI_EXTENSION_SCOPE,
      bindingId: active.bindingId,
      extensionId: active.extensionId,
      revision: active.revision,
      key: 'counter',
    };
    const initialState = await fixture.controller.handlers['extension.ui.state.query'](
      stateIdentity,
      connection,
    );
    assert.deepEqual(initialState, { ok: true, result: { found: false, value: null } });
    assert.deepEqual(
      await fixture.controller.handlers['extension.ui.state.mutate'](
        { ...stateIdentity, kind: 'set', value: { count: 1 } },
        connection,
      ),
      { ok: true, result: { changed: true } },
    );
    const rpcIdentity = {
      scopeId: DESKTOP_UI_EXTENSION_SCOPE,
      bindingId: active.bindingId,
      extensionId: active.extensionId,
      revision: active.revision,
      method: 'add',
      args: { left: 2, right: 3 },
    };
    assert.deepEqual(
      await fixture.controller.handlers['extension.ui.rpc.invoke'](rpcIdentity, connection),
      { ok: true, result: { value: { total: 5 } } },
    );

    const v2 = (await call(fixture.tools, 'define_ui', {
      id: 'dev.maka.ui.demo',
      version: '2',
      ui: [{ id: 'demo-root', surface: 'app.root', priority: 200, document: '<h1>two</h1>' }],
      permissions: { network: false, hostState: true },
      host: {
        source:
          'export default { add: (args) => ({ total: Number(args.left) + Number(args.right) + 100 }) };',
        methods: [{ name: 'add', handler: 'add' }],
      },
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
    assert.deepEqual(
      await fixture.controller.handlers['extension.ui.rpc.invoke'](
        { ...rpcIdentity, revision: v2.revision },
        connection,
      ),
      { ok: true, result: { value: { total: 105 } } },
    );
    const stale = await fixture.controller.handlers['extension.ui.rpc.invoke'](
      rpcIdentity,
      connection,
    );
    assert.equal(stale.ok, false);
    assert.equal(!stale.ok && stale.error.code, 'invalid_request');

    await fixture.runtime.close();
    fixture = await createFixture(root);
    await fixture.controller.recover();
    const recovered = await fixture.controller.handlers['extension.ui.snapshot'](
      { scopeId: DESKTOP_UI_EXTENSION_SCOPE },
      connection,
    );
    assert.equal(recovered.ok && recovered.result.contributions[0]?.document, '<h1>two</h1>');
    assert.equal(recovered.ok && recovered.result.digest, digest);
    const recoveredContribution = recovered.ok ? recovered.result.contributions[0]! : undefined;
    assert.ok(recoveredContribution);
    assert.deepEqual(
      await fixture.controller.handlers['extension.ui.state.query'](
        {
          scopeId: DESKTOP_UI_EXTENSION_SCOPE,
          bindingId: recoveredContribution.bindingId,
          extensionId: recoveredContribution.extensionId,
          revision: recoveredContribution.revision,
          key: 'counter',
        },
        connection,
      ),
      { ok: true, result: { found: true, value: { count: 1 } } },
    );
    assert.deepEqual(
      await fixture.controller.handlers['extension.ui.rpc.invoke'](
        {
          scopeId: DESKTOP_UI_EXTENSION_SCOPE,
          bindingId: recoveredContribution.bindingId,
          extensionId: recoveredContribution.extensionId,
          revision: recoveredContribution.revision,
          method: 'add',
          args: { left: 1, right: 1 },
        },
        connection,
      ),
      { ok: true, result: { value: { total: 102 } } },
    );
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
    new HostExtensionUiStateStore(root),
    uiStore,
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
