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

test('define_package installs Tool, UI, Event, dependencies, and secret configuration as one Revision', async () => {
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
    await call(management.tools(), 'define_package', {
      id: 'dev.maka.base',
      version: '1.1.0',
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
      version: '1.0.0',
      displayName: 'Codebase Studio',
      description: 'Unified authoring acceptance fixture.',
      dependencies: [{ id: 'dev.maka.base', version: '^1.0.0' }],
      configuration: {
        properties: {
          policy: { type: 'string', default: 'strict' },
          apiToken: { type: 'string', secret: true },
        },
        required: [],
      },
      runtime: {
        source:
          'export default { scan: async () => ({ issues: 1 }), observe: async () => undefined, aroundTool: async (input, _context, next) => next(input) };\n',
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
      revision: string;
      toolNames: string[];
      uiContributionIds: string[];
      eventContributionIds: string[];
    };

    assert.equal(result.extensionId, 'dev.maka.codebase-studio');
    assert.deepEqual(result.toolNames, ['codebase_scan']);
    assert.deepEqual(result.uiContributionIds, ['studio-panel']);
    assert.deepEqual(result.eventContributionIds, [
      'event:dev.maka.codebase-studio.scan.completed',
      'listener:dev.maka.codebase-studio.scan.completed:observe-scan',
      'listener:maka.tools.execute:safe-write',
    ]);
    const revisions = await Promise.all([toolStore.list(), uiStore.list(), eventStore.list()]);
    assert.deepEqual(
      revisions.map(
        (installed) =>
          installed.find(({ extensionId }) => extensionId === result.extensionId)?.revision,
      ),
      [result.revision, result.revision, result.revision],
    );

    const inspected = (await call(management.tools(), 'inspect_package', {})) as {
      contracts: {
        packages: Array<{
          extensionId: string;
          revision: string;
          dependencies: Array<{ id: string; version: string }>;
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
    assert.equal(contract.revision, result.revision);
    assert.deepEqual(contract.dependencies, [{ id: 'dev.maka.base', version: '^1.0.0' }]);
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
      ],
    );

    const activated = (await call(management.tools(), 'manage_package', {
      action: 'activate',
      extensionId: result.extensionId,
      revision: result.revision,
    })) as { entries: Array<{ scopeId: string; revision: string }> };
    assert.deepEqual(
      activated.entries.map(({ scopeId, revision }) => ({ scopeId, revision })),
      [
        { scopeId: 'session-package-test', revision: result.revision },
        { scopeId: 'desktop-ui', revision: result.revision },
      ],
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

test('define_package rejects secret defaults before writing a Revision', async () => {
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
          version: '1.0.0',
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
