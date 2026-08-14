import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { MakaTool, MakaToolContext } from '@maka/runtime/tool-runtime';
import { HostExtensionController } from '../server/extension-controller.js';
import {
  InstalledToolPackageExtensionLoader,
  StaticTrustedToolExtensionLoader,
} from '../server/extension-loader.js';
import { HostExtensionRuntime } from '../server/extension-runtime.js';
import { HostExtensionStateStore } from '../server/extension-state-store.js';
import { HostToolPackageManagementTools } from '../server/tool-package-management-tools.js';
import { ToolPackageStore } from '../server/tool-package-store.js';

test('Agent can inspect, define, test, activate, immediately invoke, update safely, stop, and delete a Tool', {
  timeout: 60_000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-agent-tool-package-'));
  const store = new ToolPackageStore(root);
  const runtime = new HostExtensionRuntime();
  const controller = new HostExtensionController(
    runtime,
    new InstalledToolPackageExtensionLoader(new StaticTrustedToolExtensionLoader(), store),
    new HostExtensionStateStore(root),
    () => assert.fail('Agent Tool failure must not drain the Host'),
  );
  const management = new HostToolPackageManagementTools(root, controller, runtime, store);
  runtime.registerHostTools(management.tools());
  const context = toolContext(root);

  try {
    await controller.recover();
    const inspect = requireTool(runtime, 'inspect_tools');
    assert.deepEqual(await inspect.impl({}, context), { revisions: [], bindings: [] });

    const define = requireTool(runtime, 'define_tool');
    assert.match(define.description, /export default \{ HandlerName:/u);
    assert.match(define.description, /intentionally replaces the full source/u);
    const projected = define.permissionArgs?.(definition('1.0.0', 'export default {};') as never, {
      sessionId: context.sessionId,
      turnId: context.turnId,
      toolCallId: context.toolCallId,
    }) as Record<string, unknown>;
    assert.equal(projected.sourceAccepted, true);
    assert.equal(projected.toolDeclarationsAccepted, true);
    assert.equal(projected.toolCount, 1);
    assert.equal(typeof projected.sourceSha256, 'string');
    assert.equal(Object.hasOwn(projected, 'source'), false);
    assert.equal(Object.hasOwn(projected, 'tools'), false);
    assert.match(String(projected.historyProjectionNotice), /intentionally redacted/u);

    await assert.rejects(
      async () =>
        await define.impl(
          definition('0.9.0', `module.exports = { Add: ({ left, right }) => left + right };`),
          context,
        ),
      /CommonJS module\.exports\/exports is unsupported/u,
    );
    await assert.rejects(
      async () =>
        await define.impl(
          definition('0.9.1', `const handlers = { Add: ({ left, right }) => left + right };`),
          context,
        ),
      /must export one default handler object/u,
    );
    assert.deepEqual(await inspect.impl({}, context), { revisions: [], bindings: [] });

    const v1 = (await define.impl(
      definition(
        '1.0.0',
        `export default { Add: ({ left, right }) => ({ sum: left + right, revision: 'v1' }) };`,
      ),
      context,
    )) as { revision: string };
    assert.match(v1.revision, /^sha256-/u);

    const testTool = requireTool(runtime, 'test_tool');
    assert.deepEqual(
      await testTool.impl(
        {
          extensionId: 'calculator',
          revision: v1.revision,
          toolName: 'Add',
          args: { left: 2, right: 3 },
        },
        context,
      ),
      { sum: 5, revision: 'v1' },
    );

    const manage = requireTool(runtime, 'manage_tool');
    const activated = (await manage.impl(
      { action: 'activate', extensionId: 'calculator', revision: v1.revision },
      context,
    )) as { binding: { status: string } };
    assert.equal(activated.binding.status, 'active');
    assert.ok(runtime.resolveTools('session-agent', []).some(({ name }) => name === 'Add'));

    const invoke = requireTool(runtime, 'invoke_tool');
    assert.deepEqual(await invoke.impl({ toolName: 'Add', args: { left: 7, right: 8 } }, context), {
      sum: 15,
      revision: 'v1',
    });

    const broken = (await define.impl(
      definition('2.0.0', `export default { WrongName: () => ({ revision: 'broken' }) };`),
      context,
    )) as { revision: string };
    await assert.rejects(
      async () =>
        await manage.impl(
          { action: 'update', extensionId: 'calculator', revision: broken.revision },
          context,
        ),
      /health_check failed/u,
    );
    assert.deepEqual(await invoke.impl({ toolName: 'Add', args: { left: 1, right: 4 } }, context), {
      sum: 5,
      revision: 'v1',
    });

    assert.deepEqual(await manage.impl({ action: 'stop', extensionId: 'calculator' }, context), {
      binding: null,
    });
    assert.equal(
      runtime.resolveTools('session-agent', []).some(({ name }) => name === 'Add'),
      false,
    );
    await manage.impl(
      { action: 'delete', extensionId: 'calculator', revision: broken.revision },
      context,
    );
    await manage.impl(
      { action: 'delete', extensionId: 'calculator', revision: v1.revision },
      context,
    );
    const final = (await inspect.impl({}, context)) as {
      revisions: unknown[];
      bindings: unknown[];
    };
    assert.deepEqual(final, { revisions: [], bindings: [] });
  } finally {
    await runtime.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test('child author installs and sandbox-tests a candidate before the parent accepts it', {
  timeout: 60_000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-child-tool-author-'));
  const store = new ToolPackageStore(root);
  let runtime = new HostExtensionRuntime();
  let controller = new HostExtensionController(
    runtime,
    new InstalledToolPackageExtensionLoader(new StaticTrustedToolExtensionLoader(), store),
    new HostExtensionStateStore(root),
    () => assert.fail('Tool author failure must not drain the Host'),
  );
  const management = new HostToolPackageManagementTools(root, controller, runtime, store);
  runtime.registerHostTools(management.tools());
  const child = toolContext(root, 'session-child-author');
  const parent = toolContext(root, 'session-parent-owner');

  try {
    await controller.recover();
    const authorTools = new Map(management.authorTools().map((tool) => [tool.name, tool]));
    assert.deepEqual([...authorTools.keys()], ['inspect_tools', 'define_tool', 'test_tool']);
    assert.equal(authorTools.has('manage_tool'), false);
    assert.equal(authorTools.has('invoke_tool'), false);

    const define = authorTools.get('define_tool');
    assert.ok(define);
    const candidate = (await define.impl(
      definition(
        '1.0.0',
        `export default { Add: ({ left, right }) => ({ sum: left + right, author: 'child' }) };`,
        'dev.maka.calculator',
      ),
      child,
    )) as { revision: string };
    assert.match(candidate.revision, /^sha256-/u);

    const testCandidate = authorTools.get('test_tool');
    assert.ok(testCandidate);
    assert.deepEqual(
      await testCandidate.impl(
        {
          extensionId: 'dev.maka.calculator',
          revision: candidate.revision,
          toolName: 'Add',
          args: { left: 4, right: 6 },
        },
        child,
      ),
      { sum: 10, author: 'child' },
    );

    assert.equal(
      runtime.resolveTools(child.sessionId, []).some(({ name }) => name === 'Add'),
      false,
    );
    assert.equal(
      runtime.resolveTools(parent.sessionId, []).some(({ name }) => name === 'Add'),
      false,
    );

    const manage = management.tools().find(({ name }) => name === 'manage_tool');
    assert.ok(manage);
    await manage.impl(
      { action: 'activate', extensionId: 'dev.maka.calculator', revision: candidate.revision },
      parent,
    );
    assert.equal(
      runtime.resolveTools(child.sessionId, []).some(({ name }) => name === 'Add'),
      false,
    );
    assert.equal(
      runtime.resolveTools(parent.sessionId, []).some(({ name }) => name === 'Add'),
      true,
    );

    const invoke = management.tools().find(({ name }) => name === 'invoke_tool');
    assert.ok(invoke);
    assert.deepEqual(await invoke.impl({ toolName: 'Add', args: { left: 8, right: 9 } }, parent), {
      sum: 17,
      author: 'child',
    });

    await runtime.close();
    runtime = new HostExtensionRuntime();
    controller = new HostExtensionController(
      runtime,
      new InstalledToolPackageExtensionLoader(new StaticTrustedToolExtensionLoader(), store),
      new HostExtensionStateStore(root),
      () => assert.fail('dotted Tool candidate recovery must not drain the Host'),
    );
    await controller.recover();
    const recoveredInvoke = new HostToolPackageManagementTools(root, controller, runtime, store)
      .tools()
      .find(({ name }) => name === 'invoke_tool');
    assert.ok(recoveredInvoke);
    assert.deepEqual(
      await recoveredInvoke.impl({ toolName: 'Add', args: { left: 10, right: 11 } }, parent),
      { sum: 21, author: 'child' },
    );
  } finally {
    await runtime.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

function definition(version: string, source: string, id = 'calculator'): Record<string, unknown> {
  return {
    id,
    version,
    source,
    tools: [
      {
        name: 'Add',
        description: 'Add two numbers',
        handler: 'Add',
        inputSchema: {
          type: 'object',
          properties: { left: { type: 'number' }, right: { type: 'number' } },
          required: ['left', 'right'],
          additionalProperties: false,
        },
        category: 'read',
        recoveryMode: 'replay_safe',
      },
    ],
    permissions: { workspace: 'none', network: false },
  };
}

function requireTool(runtime: HostExtensionRuntime, name: string): MakaTool {
  const tool = runtime
    .resolveTools('session-agent', [])
    .find((candidate) => candidate.name === name);
  assert.ok(tool, `missing management Tool ${name}`);
  return tool;
}

function toolContext(cwd: string, sessionId = 'session-agent'): MakaToolContext {
  return {
    sessionId,
    runId: 'run-agent',
    turnId: 'turn-agent',
    cwd,
    toolCallId: 'call-agent',
    abortSignal: new AbortController().signal,
    emitOutput: () => undefined,
    askUserQuestion: async () => ({ answers: [] }),
  };
}
