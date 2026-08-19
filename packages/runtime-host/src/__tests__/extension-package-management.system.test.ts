import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { MakaTool, MakaToolContext } from '@maka/runtime/tool-runtime';
import { z } from 'zod';
import { HostExtensionController } from '../server/extension-controller.js';
import {
  InstalledPluginPackageLoader,
  StaticTrustedToolExtensionLoader,
} from '../server/extension-loader.js';
import { HostExtensionPackageManagementTools } from '../server/extension-package-management-tools.js';
import { HostExtensionRuntime } from '../server/extension-runtime.js';
import { HostPluginCompositionStore } from '../server/plugin-composition-store.js';
import { PluginPackageStore } from '../server/plugin-package-store.js';
import type { ConnectionContext } from '../server/operation-dispatcher.js';

const connection: ConnectionContext = {
  hostEpoch: 'extension-package-management-test',
  connectionId: 'local-owner',
  surface: 'desktop',
  principal: 'local_os_user',
  acquireResidency: () => ({ release: () => undefined }),
};

test('define_package installs Tool, UI, Event, dependencies, and secret configuration as one Extension', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-define-package-'));
  const control = join(root, 'control');
  const runtime = new HostExtensionRuntime();
  const toolStore = new PluginPackageStore(control);
  const uiStore = toolStore;
  const eventStore = toolStore;
  const loader = new InstalledPluginPackageLoader(
    new StaticTrustedToolExtensionLoader(),
    toolStore,
  );
  const controller = new HostExtensionController(
    runtime,
    loader,
    new HostPluginCompositionStore(control),
    () => undefined,
  );
  try {
    const management = new HostExtensionPackageManagementTools(control, controller);
    assert.deepEqual(
      management.authorTools().map(({ name }) => name),
      ['inspect_package', 'define_package'],
    );
    assert.deepEqual(
      management.tools().map(({ name }) => name),
      [
        'inspect_package',
        'define_package',
        'manage_package',
        'invoke_tool',
        'emit_event',
        'call_service',
        'publish_ui_state',
      ],
    );
    await call(management.tools(), 'define_package', {
      id: 'dev.maka.base',
      runtime: {
        source: 'export default { ping: async () => ({ pong: true }) };\n',
        tools: [
          {
            name: 'base_ping',
            description: 'Dependency health check.',
            handler: 'ping',
            inputSchema: { type: 'object', additionalProperties: false },
          },
        ],
        permissions: { workspace: 'none', network: false },
      },
    });
    const result = (await call(management.tools(), 'define_package', {
      id: 'dev.maka.codebase-studio',
      displayName: 'Codebase Studio',
      description: 'Unified authoring acceptance fixture.',
      dependencies: [{ id: 'dev.maka.base' }],
      configuration: {
        properties: {
          policy: { type: 'string', default: 'strict' },
          apiToken: { type: 'string', secret: true },
        },
        required: [],
      },
      runtime: {
        source:
          'export default { scan: async () => ({ issues: 1 }), observe: async () => undefined, sum: async ({ left, right }) => ({ total: left + right }), aroundTool: async (input, _context, next) => next(input) };\n',
        tools: [
          {
            name: 'codebase_scan',
            description: 'Scan the selected codebase.',
            handler: 'scan',
            inputSchema: { type: 'object', additionalProperties: false },
            visualization: { stateKey: 'scan.result' },
          },
        ],
        events: [
          {
            name: 'dev.maka.codebase-studio.scan.completed',
            description: 'A scan completed.',
            payloadSchema: {
              type: 'object',
              properties: { issues: { type: 'number' } },
              required: ['issues'],
              additionalProperties: false,
            },
          },
        ],
        listeners: [
          {
            id: 'safe-write',
            event: 'maka.tools.execute',
            handler: 'aroundTool',
            priority: 100,
          },
          {
            id: 'observe-scan',
            event: 'dev.maka.codebase-studio.scan.completed',
            handler: 'observe',
          },
        ],
        services: [
          {
            name: 'dev.maka.codebase-studio.math',
            version: '1',
            methods: [
              {
                name: 'sum',
                description: 'Add two numbers.',
                handler: 'sum',
                inputSchema: {
                  type: 'object',
                  properties: { left: { type: 'number' }, right: { type: 'number' } },
                  required: ['left', 'right'],
                  additionalProperties: false,
                },
                outputSchema: {
                  type: 'object',
                  properties: { total: { type: 'number' } },
                  required: ['total'],
                  additionalProperties: false,
                },
              },
            ],
          },
        ],
        permissions: { workspace: 'read', network: false },
      },
      ui: {
        contributions: [
          {
            id: 'studio-panel',
            surface: 'app.slot',
            slot: 'settings.content',
            priority: 10,
            document: '<!doctype html><title>Codebase Studio</title>',
          },
        ],
        permissions: { network: false, hostState: true, sessionAccess: false },
      },
    })) as {
      extensionId: string;
      toolNames: string[];
      uiContributionIds: string[];
      eventContributionIds: string[];
      serviceContributionIds?: string[];
    };

    assert.equal(result.extensionId, 'dev.maka.codebase-studio');
    assert.deepEqual(result.toolNames, ['codebase_scan']);
    assert.deepEqual(result.uiContributionIds, ['studio-panel']);
    assert.deepEqual(result.eventContributionIds, [
      'event:dev.maka.codebase-studio.scan.completed',
      'listener:dev.maka.codebase-studio.scan.completed:observe-scan',
      'listener:maka.tools.execute:safe-write',
    ]);
    assert.deepEqual(result.serviceContributionIds, ['dev.maka.codebase-studio.math']);
    const installedPackages = await Promise.all([
      toolStore.list(),
      uiStore.list(),
      eventStore.list(),
    ]);
    assert.deepEqual(
      installedPackages.map((installed) =>
        installed.some(({ extensionId }) => extensionId === result.extensionId),
      ),
      [true, true, true],
    );

    const inspected = (await call(management.tools(), 'inspect_package', {})) as {
      contracts: {
        packages: Array<{
          extensionId: string;
          dependencies: Array<{ id: string }>;
          configuration: {
            properties: Record<string, { secret: boolean; default?: unknown }>;
            required: string[];
          };
          contributions: Array<{ kind: string; id: string }>;
        }>;
      };
    };
    const contract = inspected.contracts.packages.find(
      ({ extensionId }) => extensionId === result.extensionId,
    );
    assert.ok(contract);
    assert.deepEqual(contract.dependencies, [{ id: 'dev.maka.base' }]);
    assert.deepEqual(contract.configuration.properties, {
      apiToken: { type: 'string', secret: true },
      policy: { type: 'string', default: 'strict', secret: false },
    });
    assert.deepEqual(contract.configuration.required, []);
    assert.deepEqual(
      contract.contributions.map(({ kind, id }) => ({ kind, id })),
      [
        { kind: 'tool', id: 'codebase_scan' },
        { kind: 'ui', id: 'studio-panel' },
        { kind: 'event', id: 'dev.maka.codebase-studio.scan.completed' },
        { kind: 'listener', id: 'observe-scan' },
        { kind: 'listener', id: 'safe-write' },
        { kind: 'service', id: 'dev.maka.codebase-studio.math' },
      ],
    );

    const activated = (await call(management.tools(), 'manage_package', {
      action: 'activate',
      extensionId: result.extensionId,
    })) as { entries: Array<{ entryId: string; scopeId: string; generation: number }> };
    assert.deepEqual(
      activated.entries.map(({ scopeId }) => scopeId),
      ['session-package-test', 'desktop-ui'],
    );
    assert.ok(
      runtime
        .inspectTools('session-package-test')
        .some(({ extensionId }) => extensionId === result.extensionId),
    );
    assert.ok(
      runtime
        .inspectEvents('session-package-test')
        .some(({ extensionId }) => extensionId === result.extensionId),
    );
    assert.ok(
      runtime.inspectUi('desktop-ui').some(({ extensionId }) => extensionId === result.extensionId),
    );
    assert.deepEqual(
      await call(management.tools(), 'invoke_tool', { toolName: 'codebase_scan', args: {} }),
      { issues: 1 },
    );
    assert.deepEqual(
      await call(management.tools(), 'call_service', {
        service: 'dev.maka.codebase-studio.math',
        method: 'sum',
        input: { left: 20, right: 22 },
      }),
      { total: 42 },
    );
    const emitted = (await call(management.tools(), 'emit_event', {
      event: 'dev.maka.codebase-studio.scan.completed',
      payload: { issues: 1 },
    })) as { listenerCount: number; delivered: number };
    assert.equal(emitted.listenerCount, 1);
    assert.equal(emitted.delivered, 1);
    assert.deepEqual(
      await call(management.tools(), 'publish_ui_state', {
        extensionId: result.extensionId,
        key: 'manual.result',
        value: { accepted: true },
      }),
      {
        extensionId: result.extensionId,
        key: 'manual.result',
        published: true,
      },
    );
    const desktopEntry = activated.entries.find(({ scopeId }) => scopeId === 'desktop-ui');
    assert.ok(desktopEntry);
    assert.deepEqual(
      await controller.handlers['extension.ui.state.query'](
        {
          scopeId: 'desktop-ui',
          entryId: desktopEntry.entryId,
          extensionId: result.extensionId,
          generation: desktopEntry.generation,
          key: 'scan.result',
        },
        connection,
      ),
      { ok: true, result: { found: true, value: { issues: 1 } } },
    );
    assert.deepEqual(
      await controller.handlers['extension.ui.state.query'](
        {
          scopeId: 'desktop-ui',
          entryId: desktopEntry.entryId,
          extensionId: result.extensionId,
          generation: desktopEntry.generation,
          key: 'manual.result',
        },
        connection,
      ),
      { ok: true, result: { found: true, value: { accepted: true } } },
    );
    await call(management.tools(), 'manage_package', {
      action: 'stop',
      extensionId: result.extensionId,
    });
    assert.equal(
      runtime
        .inspectTools('session-package-test')
        .some(({ extensionId }) => extensionId === result.extensionId),
      false,
    );
    assert.equal(
      runtime.inspectUi('desktop-ui').some(({ extensionId }) => extensionId === result.extensionId),
      false,
    );
    assert.equal(
      runtime
        .inspectEvents('session-package-test')
        .some(({ extensionId }) => extensionId === result.extensionId),
      false,
    );
  } finally {
    await runtime.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test('define_package rejects secret defaults before writing an Extension', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-define-package-secret-'));
  const runtime = new HostExtensionRuntime();
  const toolStore = new PluginPackageStore(root);
  const loader = new InstalledPluginPackageLoader(
    new StaticTrustedToolExtensionLoader(),
    toolStore,
  );
  const controller = new HostExtensionController(
    runtime,
    loader,
    new HostPluginCompositionStore(root),
    () => undefined,
  );
  try {
    const define = requireTool(
      new HostExtensionPackageManagementTools(root, controller).tools(),
      'define_package',
    );
    assert.throws(
      () =>
        (define.parameters as z.ZodType).parse({
          id: 'dev.maka.invalid-secret',
          configuration: {
            properties: {
              apiToken: { type: 'string', secret: true, default: 'must-not-leak' },
            },
          },
          tool: {
            source: 'export default { run: async () => ({ ok: true }) };',
            tools: [
              {
                name: 'run',
                description: 'run',
                handler: 'run',
                inputSchema: { type: 'object' },
              },
            ],
            permissions: { workspace: 'none', network: false },
          },
        }),
      /secret configuration must not declare a default value/u,
    );
    assert.deepEqual(await toolStore.list(), []);
  } finally {
    await runtime.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

async function call(tools: readonly MakaTool[], name: string, input: unknown): Promise<unknown> {
  const tool = requireTool(tools, name);
  const parsed = (tool.parameters as z.ZodType).parse(input);
  return await tool.impl(parsed, context());
}

function requireTool(tools: readonly MakaTool[], name: string): MakaTool {
  const tool = tools.find((candidate) => candidate.name === name);
  assert.ok(tool, `missing Tool ${name}`);
  return tool;
}

function context(): MakaToolContext {
  return {
    sessionId: 'session-package-test',
    turnId: 'turn-package-test',
    cwd: tmpdir(),
    toolCallId: 'call-package-test',
    abortSignal: new AbortController().signal,
    emitOutput: () => undefined,
  };
}
