import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
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
import { ToolPackageActivation } from '../server/tool-package-worker.js';
import type { ConnectionContext } from '../server/operation-dispatcher.js';

const connection: ConnectionContext = {
  hostEpoch: 'tool-package-system-test',
  connectionId: 'local-owner',
  surface: 'desktop',
  principal: 'local_os_user',
  acquireResidency: () => ({ release: () => undefined }),
};

test('real Tool package installs, runs in a sandboxed process, updates, drains, and uninstalls', {
  timeout: 60_000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-tool-package-'));
  const control = join(root, 'control');
  const workspace = join(root, 'workspace');
  await mkdir(workspace, { recursive: true });
  const packageV1 = await createPackage(root, 'v1', 21);
  const packageV2 = await createPackage(root, 'v2', 27);
  const packageStore = new ToolPackageStore(control);
  const loader = new InstalledToolPackageExtensionLoader(
    new StaticTrustedToolExtensionLoader(),
    packageStore,
  );
  const runtime = new HostExtensionRuntime();
  const controller = new HostExtensionController(
    runtime,
    loader,
    new HostExtensionStateStore(control),
    () => assert.fail('deterministic Tool package failures must not drain the Host'),
  );

  try {
    await controller.recover();
    const installedV1 = await controller.handlers['extension.package.install'](
      { sourcePath: packageV1 },
      connection,
    );
    assert.equal(installedV1.ok, true);
    assert.match(installedV1.ok ? installedV1.result.revision : '', /^sha256-[a-f0-9]{64}$/u);
    const revisionV1 = installedV1.ok ? installedV1.result.revision : '';
    assert.deepEqual(installedV1.ok && installedV1.result.toolNames, ['Weather']);

    const installedV2 = await controller.handlers['extension.package.install'](
      { sourcePath: packageV2 },
      connection,
    );
    assert.equal(installedV2.ok, true);
    const revisionV2 = installedV2.ok ? installedV2.result.revision : '';
    assert.notEqual(revisionV1, revisionV2);
    assert.equal((await stat(join(packageStore.root, 'weather', revisionV1))).isDirectory(), true);

    const enabled = await controller.handlers['extension.catalog.mutate'](
      {
        kind: 'enable',
        bindingId: 'weather-binding',
        scopeId: 'session-1',
        extensionId: 'weather',
        revision: revisionV1,
      },
      connection,
    );
    assert.equal(enabled.ok, true, JSON.stringify(enabled));
    assert.equal(enabled.ok && enabled.result.binding?.status, 'active');
    assert.deepEqual(await invoke(runtime, workspace, 'v1'), {
      label: 'v1',
      temperature: 21,
      location: 'Shanghai',
    });
    assert.equal(await readFile(join(workspace, 'weather-v1.txt'), 'utf8'), 'Shanghai\n');

    let startedSlow: (() => void) | undefined;
    const slowStarted = new Promise<void>((resolve) => {
      startedSlow = resolve;
    });
    const oldTool = runtime.resolveTools('session-1', []).find(({ name }) => name === 'Weather');
    assert.ok(oldTool);
    const oldInvocation = oldTool.impl(
      { location: 'Ningbo', delayMs: 500 },
      {
        ...invocationContext(workspace),
        toolCallId: 'slow-old-call',
        emitOutput: () => startedSlow?.(),
      },
    );
    await slowStarted;
    const upgradeTask = controller.handlers['extension.catalog.mutate'](
      { kind: 'update', bindingId: 'weather-binding', revision: revisionV2 },
      connection,
    );
    await waitForRevision(runtime, revisionV2);
    assert.deepEqual(await invoke(runtime, workspace, 'v2-during-drain', 'v2'), {
      label: 'v2',
      temperature: 27,
      location: 'Shanghai',
    });
    assert.deepEqual(await oldInvocation, {
      label: 'v1',
      temperature: 21,
      location: 'Ningbo',
    });
    const upgraded = await upgradeTask;
    assert.equal(upgraded.ok, true);
    assert.equal(upgraded.ok && upgraded.result.binding?.lastGoodRevision, revisionV2);
    assert.deepEqual(await invoke(runtime, workspace, 'v2'), {
      label: 'v2',
      temperature: 27,
      location: 'Shanghai',
    });

    const retained = await controller.handlers['extension.package.uninstall'](
      { extensionId: 'weather', revision: revisionV2 },
      connection,
    );
    assert.equal(retained.ok, false);
    assert.equal(!retained.ok && retained.error.code, 'operation_conflict');

    assert.deepEqual(
      await controller.handlers['extension.catalog.mutate'](
        { kind: 'remove', bindingId: 'weather-binding' },
        connection,
      ),
      { ok: true, result: { binding: null } },
    );
    assert.deepEqual(
      await controller.handlers['extension.package.uninstall'](
        { extensionId: 'weather', revision: revisionV1 },
        connection,
      ),
      { ok: true, result: {} },
    );
    assert.deepEqual(
      await controller.handlers['extension.package.uninstall'](
        { extensionId: 'weather', revision: revisionV2 },
        connection,
      ),
      { ok: true, result: {} },
    );
    assert.deepEqual(await packageStore.list(), []);
    assert.deepEqual(await controller.handlers['extension.catalog.query']({}, connection), {
      ok: true,
      result: { revisions: [], bindings: [] },
    });
  } finally {
    await runtime.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test('Tool package install rejects traversal, unknown fields, and missing entries', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-tool-package-invalid-'));
  const source = join(root, 'source');
  const store = new ToolPackageStore(join(root, 'control'));
  try {
    await mkdir(source, { recursive: true });
    await writeFile(
      join(source, 'maka.tool.json'),
      JSON.stringify({
        schemaVersion: 1,
        id: 'invalid',
        version: '1.0.0',
        entry: '../escape.mjs',
        tools: [toolManifest()],
        permissions: { workspace: 'none', network: false },
      }),
    );
    await assert.rejects(store.install(source), /entry is invalid/u);

    await writeFile(
      join(source, 'maka.tool.json'),
      JSON.stringify({
        schemaVersion: 1,
        id: 'invalid',
        version: '1.0.0',
        entry: 'dist/missing.mjs',
        tools: [toolManifest()],
        permissions: { workspace: 'none', network: false },
        unexpected: true,
      }),
    );
    await assert.rejects(store.install(source), /unknown fields/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Tool package Store detects post-install content corruption', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-tool-package-corrupt-'));
  const source = await createPackage(root, 'sealed', 42);
  const store = new ToolPackageStore(join(root, 'control'));
  try {
    const installed = await store.install(source);
    await writeFile(installed.entry, 'export default {};\n', 'utf8');
    await assert.rejects(
      store.load(installed.extensionId, installed.revision),
      /content hash does not match/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Tool worker contains crashes, honors abort, and enforces denied network', {
  timeout: 30_000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-tool-worker-faults-'));
  const source = join(root, 'source');
  const store = new ToolPackageStore(join(root, 'control'));
  let networkRequests = 0;
  const server = createServer((_request, response) => {
    networkRequests += 1;
    response.end('unexpected');
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  try {
    await createFaultPackage(source, `http://127.0.0.1:${address.port}/denied`);
    const activation = new ToolPackageActivation(await store.install(source));
    try {
      await activation.healthCheck();
      const tools = new Map(activation.tools().map((tool) => [tool.name, tool]));
      const context = invocationContext(root);

      await assert.rejects(
        async () => await tools.get('Crash')?.impl({}, context),
        /without a result/u,
      );
      assert.deepEqual(await tools.get('Echo')?.impl({ value: 'alive' }, context), {
        value: 'alive',
      });
      await assert.rejects(
        async () => await tools.get('Network')?.impl({}, context),
        /fetch|network|operation not permitted|failed/u,
      );
      assert.equal(networkRequests, 0);

      const abort = new AbortController();
      const hanging = tools.get('Hang')?.impl({}, { ...context, abortSignal: abort.signal });
      setTimeout(() => abort.abort(new Error('test abort')), 50).unref();
      await assert.rejects(async () => await hanging, /aborted/u);
    } finally {
      await activation.dispose();
    }
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(root, { recursive: true, force: true });
  }
});

async function createPackage(root: string, label: string, temperature: number): Promise<string> {
  const source = join(root, `source-${label}`);
  await mkdir(join(source, 'dist'), { recursive: true });
  await writeFile(
    join(source, 'maka.tool.json'),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        id: 'weather',
        version: `1.0.${temperature}`,
        entry: 'dist/index.mjs',
        tools: [toolManifest()],
        permissions: { workspace: 'write', network: false },
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    join(source, 'dist', 'index.mjs'),
    `import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';
export default {
  Weather: async (args, context) => {
    context.emitOutput('stdout', 'weather:${label}');
    if (args.delayMs) await new Promise((resolve) => setTimeout(resolve, args.delayMs));
    await appendFile(join(context.cwd, 'weather-${label}.txt'), args.location + '\\n', 'utf8');
    return { label: ${JSON.stringify(label)}, temperature: ${temperature}, location: args.location };
  },
};
`,
  );
  return source;
}

function toolManifest(): Record<string, unknown> {
  return {
    name: 'Weather',
    description: 'Read the test weather',
    handler: 'Weather',
    inputSchema: {
      type: 'object',
      properties: {
        location: { type: 'string' },
        delayMs: { type: 'number', minimum: 0, maximum: 10_000 },
      },
      required: ['location'],
      additionalProperties: false,
    },
    displayName: 'Weather',
    category: 'file_write',
    recoveryMode: 'never_auto_retry',
  };
}

async function createFaultPackage(source: string, deniedUrl: string): Promise<void> {
  await mkdir(join(source, 'dist'), { recursive: true });
  const declaration = (name: string): Record<string, unknown> => ({
    name,
    description: `Exercise ${name}`,
    handler: name,
    inputSchema: { type: 'object', additionalProperties: true },
    category: 'shell_unsafe',
    recoveryMode: 'never_auto_retry',
  });
  await writeFile(
    join(source, 'maka.tool.json'),
    JSON.stringify({
      schemaVersion: 1,
      id: 'faults',
      version: '1.0.0',
      entry: 'dist/index.mjs',
      tools: ['Crash', 'Echo', 'Network', 'Hang'].map(declaration),
      permissions: { workspace: 'none', network: false },
    }),
  );
  await writeFile(
    join(source, 'dist', 'index.mjs'),
    `export default {
  Crash: () => process.exit(23),
  Echo: ({ value }) => ({ value }),
  Network: async () => ({ body: await (await fetch(${JSON.stringify(deniedUrl)})).text() }),
  Hang: async (_args, context) => await new Promise((_resolve, reject) => context.abortSignal.addEventListener('abort', () => reject(context.abortSignal.reason), { once: true })),
};
`,
  );
}

function invocationContext(cwd: string): Parameters<MakaTool['impl']>[1] {
  return {
    sessionId: 'fault-session',
    turnId: 'fault-turn',
    cwd,
    toolCallId: 'fault-call',
    abortSignal: new AbortController().signal,
    emitOutput: () => undefined,
    askUserQuestion: async () => ({ answers: [] }),
  };
}

async function waitForRevision(runtime: HostExtensionRuntime, revision: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (runtime.inspect('weather-binding').current?.revision === revision) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`Tool revision did not become current: ${revision}`);
}

async function invoke(
  runtime: HostExtensionRuntime,
  workspace: string,
  label: string,
  expectedRevisionLabel = label,
): Promise<unknown> {
  const tool = runtime.resolveTools('session-1', []).find(({ name }) => name === 'Weather');
  assert.ok(tool);
  const output: string[] = [];
  const result = await tool.impl(
    { location: 'Shanghai' },
    {
      sessionId: 'session-1',
      runId: `run-${label}`,
      turnId: `turn-${label}`,
      cwd: workspace,
      toolCallId: `call-${label}`,
      abortSignal: new AbortController().signal,
      emitOutput: (_stream, chunk) => output.push(chunk),
      askUserQuestion: async () => ({ answers: [] }),
    },
  );
  assert.deepEqual(output, [`weather:${expectedRevisionLabel}`]);
  return result;
}
