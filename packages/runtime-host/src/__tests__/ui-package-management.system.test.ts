import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { MakaTool } from '@maka/runtime/tool-runtime';
import { decodeExtensionUiSnapshotResult } from '../protocol/extension.js';
import { HostExtensionController } from '../server/extension-controller.js';
import {
  InstalledToolPackageExtensionLoader,
  StaticTrustedToolExtensionLoader,
} from '../server/extension-loader.js';
import { HostExtensionRuntime } from '../server/extension-runtime.js';
import { HostExtensionStateStore } from '../server/extension-state-store.js';
import { HostExtensionUiStateStore } from '../server/extension-ui-state-store.js';
import { ToolPackageStore } from '../server/tool-package-store.js';
import { HostToolPackageManagementTools } from '../server/tool-package-management-tools.js';
import {
  DESKTOP_UI_EXTENSION_SCOPE,
  HostUiPackageManagementTools,
} from '../server/ui-package-management-tools.js';
import { UiPackageStore } from '../server/ui-package-store.js';

test('UI author surface exposes only inspect, define, and test', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-ui-author-tools-'));
  const fixture = await createFixture(root);
  try {
    const authorTools = new Map(fixture.management.authorTools().map((tool) => [tool.name, tool]));
    assert.deepEqual([...authorTools.keys()], ['inspect_ui', 'define_ui', 'test_ui']);
    assert.equal(authorTools.has('manage_ui'), false);
    assert.equal(authorTools.has('publish_ui_state'), false);
    const inspected = (await call(fixture.management.tools(), 'inspect_ui', {})) as {
      slots: string[];
      surfaces: string[];
    };
    assert.deepEqual(inspected.slots, [
      'sidebar.footer',
      'conversation.header',
      'settings.content',
    ]);
    assert.deepEqual(inspected.surfaces, ['app.root', 'app.overlay', 'app.slot']);
  } finally {
    await fixture.runtime.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test('agent-authored client-only UI survives update, rollback boundary, and Host restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-ui-package-'));
  try {
    let fixture = await createFixture(root);
    const v1 = (await call(fixture.tools, 'define_ui', {
      id: 'dev.maka.ui.demo',
      version: '1',
      ui: [
        { id: 'demo-root', surface: 'app.root', priority: 200, document: '<h1>one</h1>' },
        {
          id: 'settings-card',
          surface: 'app.slot',
          slot: 'settings.content',
          priority: 10,
          document: '<section>settings one</section>',
        },
      ],
      permissions: { network: false, hostState: true },
      host: {
        source:
          'export default { add: (args) => ({ total: Number(args.left) + Number(args.right) }) };',
        methods: [{ name: 'add', handler: 'add' }],
      },
    })) as { revision: string; uiContributionIds: string[]; toolNames: string[] };
    assert.deepEqual(v1.uiContributionIds, ['demo-root', 'settings-card']);
    assert.deepEqual(v1.toolNames, []);
    const tested = (await call(fixture.tools, 'test_ui', {
      extensionId: 'dev.maka.ui.demo',
      revision: v1.revision,
    })) as {
      ok: boolean;
      contributions: Array<{ document: string; hostMethods: string[]; slot?: string }>;
    };
    assert.equal(tested.ok, true);
    assert.equal(tested.contributions[0]?.document, '<h1>one</h1>');
    assert.equal(tested.contributions[1]?.slot, 'settings.content');
    assert.deepEqual(tested.contributions[0]?.hostMethods, ['add']);
    await call(fixture.tools, 'manage_ui', {
      action: 'activate',
      extensionId: 'dev.maka.ui.demo',
      revision: v1.revision,
    });
    const customRootInspection = (await call(fixture.tools, 'inspect_ui', {})) as {
      slots: string[];
      slotCompatibility: { compatible: boolean; rootExtensionId: string };
    };
    assert.deepEqual(customRootInspection.slots, []);
    assert.deepEqual(customRootInspection.slotCompatibility, {
      compatible: true,
      dynamic: true,
      rootExtensionId: 'dev.maka.ui.demo',
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
    assert.deepEqual(
      await call(fixture.tools, 'publish_ui_state', {
        extensionId: 'dev.maka.ui.demo',
        key: 'project-plan',
        value: { sequence: 1, tasks: [{ id: 'design', status: 'done' }] },
      }),
      {
        changed: true,
        extensionId: 'dev.maka.ui.demo',
        revision: v1.revision,
        key: 'project-plan',
      },
    );
    assert.deepEqual(
      await fixture.controller.handlers['extension.ui.state.query'](
        { ...stateIdentity, key: 'project-plan' },
        connection,
      ),
      {
        ok: true,
        result: {
          found: true,
          value: { sequence: 1, tasks: [{ id: 'design', status: 'done' }] },
        },
      },
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
      ui: [
        { id: 'demo-root', surface: 'app.root', priority: 200, document: '<h1>two</h1>' },
        {
          id: 'settings-card',
          surface: 'app.slot',
          slot: 'settings.content',
          priority: 10,
          document: '<section>settings two</section>',
        },
      ],
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
    assert.ok(snapshot.ok);
    assert.doesNotThrow(() => decodeExtensionUiSnapshotResult(snapshot.result));
    assert.equal('scopeId' in snapshot.result.contributions[0]!, false);
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
      join(source, 'maka.extension.json'),
      JSON.stringify({
        schemaVersion: 1,
        id: 'dev.maka.ui.integrity',
        version: '1',
        ui: {
          contributions: [
            { id: 'root', surface: 'app.root', priority: 1, document: 'documents/root.html' },
          ],
          permissions: { network: false },
        },
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
    await writeFile(join(linked, 'maka.extension.json'), '{}');
    await symlink(join(source, 'documents', 'root.html'), join(linked, 'root.html'));
    await assert.rejects(store.install(linked), /may not contain symlinks/);

    const unsupported = join(root, 'unsupported-slot');
    await mkdir(join(unsupported, 'documents'), { recursive: true });
    await writeFile(
      join(unsupported, 'maka.extension.json'),
      JSON.stringify({
        schemaVersion: 1,
        id: 'dev.maka.ui.unsupported-slot',
        version: '1',
        ui: {
          contributions: [
            {
              id: 'unknown',
              surface: 'app.slot',
              slot: 'unknown.area',
              priority: 1,
              document: 'documents/unknown.html',
            },
          ],
          permissions: { network: false },
        },
      }),
    );
    await writeFile(join(unsupported, 'documents', 'unknown.html'), '<main>unknown</main>');
    const dynamicSlot = await store.install(unsupported);
    assert.equal(dynamicSlot.manifest.ui[0]?.slot, 'unknown.area');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('one immutable package Revision carries a Tool and a complete Maka root snapshot', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-combined-extension-'));
  const source = join(root, 'source');
  const control = join(root, 'control');
  const runtime = new HostExtensionRuntime();
  try {
    await mkdir(join(source, 'documents'), { recursive: true });
    await mkdir(join(source, 'dist'), { recursive: true });
    await mkdir(join(source, '.git'), { recursive: true });
    await writeFile(join(source, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    await writeFile(
      join(source, 'maka.extension.json'),
      JSON.stringify({
        schemaVersion: 1,
        id: 'dev.maka.project-canvas',
        version: '1',
        runtime: {
          entry: 'dist/index.mjs',
          tools: [
            {
              name: 'project_plan_commit',
              description: 'Commit a project plan snapshot',
              handler: 'projectPlanCommit',
              inputSchema: { type: 'object', additionalProperties: true },
              visualization: { stateKey: 'project-plan' },
            },
          ],
          events: [],
          listeners: [],
          services: [],
          timers: [],
          permissions: { workspace: 'none', network: false },
        },
        ui: {
          contributions: [
            {
              id: 'project-canvas',
              surface: 'app.root',
              priority: 200,
              document: 'documents/project-canvas.html',
            },
          ],
          permissions: { network: false, hostState: true, sessionAccess: true },
        },
      }),
    );
    await writeFile(join(source, 'documents', 'project-canvas.html'), '<main>canvas</main>');
    await writeFile(
      join(source, 'dist', 'index.mjs'),
      'export default { projectPlanCommit: (input) => input };\n',
    );

    const toolStore = new ToolPackageStore(control);
    const uiStore = new UiPackageStore(control);
    const loader = new InstalledToolPackageExtensionLoader(
      new StaticTrustedToolExtensionLoader(),
      toolStore,
      uiStore,
    );
    const installed = await loader.installPackage(source);
    assert.deepEqual(installed.toolNames, ['project_plan_commit']);
    assert.deepEqual(installed.uiContributionIds, ['project-canvas']);
    assert.equal((await loader.list()).length, 1);
    await writeFile(join(source, '.git', 'HEAD'), 'ref: refs/heads/other\n');
    assert.equal((await loader.installPackage(source)).revision, installed.revision);

    await runtime.installRevision(await loader.load(installed.extensionId, installed.revision));
    const controller = new HostExtensionController(
      runtime,
      loader,
      new HostExtensionStateStore(control),
      () => undefined,
      new HostExtensionUiStateStore(control),
      uiStore,
    );
    await controller.recover();
    for (const binding of [
      { bindingId: 'project-canvas-ui', scopeId: DESKTOP_UI_EXTENSION_SCOPE },
      { bindingId: 'project-canvas-session', scopeId: 'session-1' },
    ]) {
      assert.equal(
        (
          await controller.handlers['extension.catalog.mutate'](
            {
              kind: 'enable',
              ...binding,
              extensionId: installed.extensionId,
              revision: installed.revision,
            },
            connection,
          )
        ).ok,
        true,
      );
    }
    assert.equal(runtime.inspectUi(DESKTOP_UI_EXTENSION_SCOPE)[0]?.surface, 'app.root');
    assert.equal(runtime.inspectUi(DESKTOP_UI_EXTENSION_SCOPE)[0]?.sessionAccess, true);
    assert.ok(
      runtime.resolveTools('session-1', []).some(({ name }) => name === 'project_plan_commit'),
    );

    const invoke = new HostToolPackageManagementTools(control, controller, runtime, toolStore)
      .tools()
      .find(({ name }) => name === 'invoke_tool');
    assert.ok(invoke);
    await invoke.impl(
      { toolName: 'project_plan_commit', args: { title: 'Aurora' } },
      {
        sessionId: 'session-1',
        turnId: 'turn-1',
        cwd: root,
        toolCallId: 'call-1',
        abortSignal: new AbortController().signal,
        emitOutput: () => undefined,
      },
    );
    const activeUi = runtime.inspectUi(DESKTOP_UI_EXTENSION_SCOPE)[0]!;
    assert.deepEqual(
      await controller.handlers['extension.ui.state.query'](
        {
          scopeId: DESKTOP_UI_EXTENSION_SCOPE,
          bindingId: activeUi.bindingId,
          extensionId: activeUi.extensionId,
          revision: activeUi.revision,
          key: 'project-plan',
        },
        connection,
      ),
      { ok: true, result: { found: true, value: { title: 'Aurora' } } },
    );
  } finally {
    await runtime.close().catch(() => undefined);
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
  const management = new HostUiPackageManagementTools(root, controller, runtime, uiStore);
  const tools = management.tools();
  return { runtime, controller, tools, management };
}

async function call(tools: readonly MakaTool[], name: string, input: unknown): Promise<unknown> {
  const tool = tools.find((item) => item.name === name);
  assert.ok(tool, `missing ${name}`);
  return tool.impl(input, {} as never);
}
