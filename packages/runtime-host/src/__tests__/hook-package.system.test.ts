import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { RuntimeEvent } from '@maka/core/runtime-event';
import type { SessionHeader } from '@maka/core/session';
import { createExternalExecutionBoundary } from '@maka/core/sandbox-boundary';
import type { SessionEvent } from '@maka/core/events';
import { ToolRuntime, type MakaToolContext } from '@maka/runtime/tool-runtime';
import { HostExtensionController } from '../server/extension-controller.js';
import {
  InstalledToolPackageExtensionLoader,
  StaticTrustedToolExtensionLoader,
} from '../server/extension-loader.js';
import { HostExtensionRuntime } from '../server/extension-runtime.js';
import { HostExtensionStateStore } from '../server/extension-state-store.js';
import { createHostHookComposition } from '../server/host-hook-composition.js';
import { HookPackageStore } from '../server/hook-package-store.js';
import { HostHookPackageManagementTools } from '../server/hook-package-management-tools.js';
import { ToolPackageStore } from '../server/tool-package-store.js';
import { UiPackageStore } from '../server/ui-package-store.js';
import type { ConnectionContext } from '../server/operation-dispatcher.js';

const connection: ConnectionContext = {
  hostEpoch: 'hook-package-system-test',
  connectionId: 'local-owner',
  surface: 'desktop',
  principal: 'local_os_user',
  acquireResidency: () => ({ release: () => undefined }),
};

test('Tool, UI, and Hook share one Revision with typed dispatch, rollback, and restart recovery', {
  timeout: 60_000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-hook-package-'));
  const control = join(root, 'control');
  const goodSource = join(root, 'good');
  const badSource = join(root, 'bad');
  const events: RuntimeEvent[] = [];
  let fixture: ReturnType<typeof createFixture> | undefined;
  try {
    await writeCombinedPackage(goodSource, false);
    await writeCombinedPackage(badSource, true);
    fixture = createFixture(control);
    const installed = await fixture.loader.installPackage(goodSource);
    assert.deepEqual(installed.toolNames, ['echo']);
    assert.deepEqual(installed.uiContributionIds, ['hook-status']);
    assert.deepEqual(installed.hookContributionIds, [
      'PostToolUse:post',
      'PreToolUse:gate',
      'RunEnd:end',
      'RunStart:start',
      'UserPromptSubmit:prompt',
    ]);
    const bad = await fixture.loader.installPackage(badSource);
    await fixture.controller.recover();
    const enabled = await fixture.controller.handlers['extension.catalog.mutate'](
      {
        kind: 'enable',
        bindingId: 'hook-binding',
        scopeId: 'session-1',
        extensionId: installed.extensionId,
        revision: installed.revision,
      },
      connection,
    );

    assert.equal(enabled.ok, true, JSON.stringify(enabled));
    assert.equal(fixture.runtime.inspectTools('session-1').length, 1);
    assert.equal(fixture.runtime.inspectUi('session-1').length, 1);
    assert.equal(fixture.runtime.inspectHooks('session-1').length, 5);

    const dispatcher = createHostHookComposition({
      stateRoot: root,
      extensions: fixture.runtime,
      runtimeEvents: {
        appendRuntimeEvent: async (_sessionId, _runId, event) => {
          events.push(event);
        },
      },
    }).dispatcherFor(header(root));
    dispatcher.prepareTurn('turn-1');
    const runtimeContext = {
      invocationId: 'invocation-1',
      sessionId: 'session-1',
      runId: 'run-1',
      turnId: 'turn-1',
      cwd: root,
      permissionMode: 'ask',
      origin: 'provider' as const,
    };
    const prompt = await dispatcher.runExtensionHook?.(
      'UserPromptSubmit',
      { text: 'hello' },
      new AbortController().signal,
      runtimeContext,
    );
    assert.deepEqual(prompt?.payload, { text: '[hook] hello' });
    await dispatcher.runExtensionHook?.(
      'RunStart',
      { modelId: 'test' },
      new AbortController().signal,
      runtimeContext,
    );
    const gate = await dispatcher.runPreToolUse(
      {
        schema_version: 1,
        hook_event_name: 'PreToolUse',
        session_id: 'session-1',
        turn_id: 'turn-1',
        run_id: 'run-1',
        tool_use_id: 'call-1',
        tool_name: 'Bash',
        tool_input: { command: 'git push' },
        cwd: root,
        permission_mode: 'ask',
        origin: 'provider',
      },
      new AbortController().signal,
      { invocationId: 'invocation-1' },
    );
    assert.equal(gate.denied, true);
    assert.match(gate.reason ?? '', /blocked by extension/u);
    const post = await dispatcher.runExtensionHook?.(
      'PostToolUse',
      { toolUseId: 'call-2', toolName: 'echo', result: { value: 1 } },
      new AbortController().signal,
      runtimeContext,
    );
    assert.deepEqual(post?.payload, {
      toolUseId: 'call-2',
      toolName: 'echo',
      result: { wrapped: { value: 1 } },
    });
    await dispatcher.runExtensionHook?.(
      'RunEnd',
      { outcome: 'completed' },
      new AbortController().signal,
      runtimeContext,
    );
    dispatcher.releaseTurn('turn-1');
    assert.deepEqual(
      events.map((event) => event.actions?.hookCompleted?.eventName),
      ['UserPromptSubmit', 'RunStart', 'PreToolUse', 'PostToolUse', 'RunEnd'],
    );
    assert.ok(events.every((event) => event.actions?.hookCompleted?.source === 'extension'));

    const runtimeDispatcher = createHostHookComposition({
      stateRoot: root,
      extensions: fixture.runtime,
      runtimeEvents: {
        appendRuntimeEvent: async (_sessionId, _runId, event) => {
          events.push(event);
        },
      },
    }).dispatcherFor(header(root));
    const toolRuntime = new ToolRuntime({
      sessionId: 'session-1',
      header: header(root),
      connection: {
        slug: 'connection-1',
        providerType: 'openai',
        defaultModel: 'model-1',
      },
      modelId: 'model-1',
      appendMessage: async () => undefined,
      readExecutionBoundary: async () => createExternalExecutionBoundary(),
      newId: randomId,
      now: Date.now,
      getPermissionPauseTarget: () => null,
      turnId: 'turn-2',
      runId: 'run-2',
      invocationId: 'invocation-2',
      preToolUseHooks: runtimeDispatcher,
    });
    const echo = fixture.runtime.resolveTools('session-1', []).find(({ name }) => name === 'echo');
    assert.ok(echo);
    const sessionEvents: SessionEvent[] = [];
    const settled = await toolRuntime.settleToolCall({
      tool: echo,
      turnId: 'turn-2',
      toolCallId: 'call-real',
      input: { value: 42 },
      abortSignal: new AbortController().signal,
      eventSink: {
        push: (event) => sessionEvents.push(event),
        pushAndWaitUntilConsumed: async (event) => {
          sessionEvents.push(event);
        },
      },
    });
    assert.match(JSON.stringify(settled.result), /wrapped/u);
    assert.equal(events.at(-1)?.actions?.hookCompleted?.eventName, 'PostToolUse');
    await toolRuntime.endTurn();

    const rejected = await fixture.controller.handlers['extension.catalog.mutate'](
      { kind: 'update', bindingId: 'hook-binding', revision: bad.revision },
      connection,
    );
    assert.equal(rejected.ok, false);
    const afterFailure = await fixture.controller.handlers['extension.catalog.query'](
      {},
      connection,
    );
    assert.ok(afterFailure.ok);
    const retained = afterFailure.ok
      ? afterFailure.result.bindings.find(({ bindingId }) => bindingId === 'hook-binding')
      : undefined;
    assert.equal(retained?.lastGoodRevision, installed.revision);
    assert.equal(retained?.status, 'failed');
    assert.equal(fixture.runtime.inspectHooks('session-1').length, 5);

    await fixture.runtime.close();
    fixture = createFixture(control);
    await fixture.controller.recover();
    assert.equal(fixture.runtime.inspectHooks('session-1').length, 5);
    assert.equal(fixture.runtime.inspectTools('session-1').length, 1);
    const removed = await fixture.controller.handlers['extension.catalog.mutate'](
      { kind: 'remove', bindingId: 'hook-binding' },
      connection,
    );
    assert.equal(removed.ok, true);
    assert.equal(fixture.runtime.inspectHooks('session-1').length, 0);
  } finally {
    await fixture?.runtime.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test('Agent Hook tools define, sandbox-test, activate, inspect, and stop a dynamic Hook', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-hook-management-'));
  const control = join(root, 'control');
  const fixture = createFixture(control);
  try {
    await fixture.controller.recover();
    const management = new HostHookPackageManagementTools(
      control,
      fixture.controller,
      fixture.runtime,
      fixture.hookStore,
    );
    const tools = management.tools();
    assert.deepEqual(
      tools.map(({ name }) => name),
      ['inspect_hooks', 'define_hook', 'test_hook', 'manage_hook'],
    );
    const context = toolContext(root);
    const defined = (await tools
      .find(({ name }) => name === 'define_hook')!
      .impl(
        {
          id: 'dev.maka.dynamic.policy',
          version: '1.0.0',
          source:
            "export default { protect: async () => ({ decision: 'deny', reason: 'dynamic policy' }) };\n",
          hooks: [
            {
              id: 'protect',
              event: 'PreToolUse',
              handler: 'protect',
              matcher: 'Bash',
              priority: 10,
              timeoutMs: 1_000,
            },
          ],
          permissions: { workspace: 'none', network: false },
        } as never,
        context,
      )) as { revision: string };
    assert.match(defined.revision, /^sha256-[a-f0-9]{64}$/u);
    const tested = await tools
      .find(({ name }) => name === 'test_hook')!
      .impl(
        {
          extensionId: 'dev.maka.dynamic.policy',
          revision: defined.revision,
          event: 'PreToolUse',
          hookId: 'protect',
          payload: { toolName: 'Bash' },
        } as never,
        context,
      );
    assert.deepEqual(tested, { decision: 'deny', reason: 'dynamic policy' });
    await tools
      .find(({ name }) => name === 'manage_hook')!
      .impl(
        {
          action: 'activate',
          extensionId: 'dev.maka.dynamic.policy',
          revision: defined.revision,
        } as never,
        context,
      );
    assert.equal(fixture.runtime.inspectHooks('session-1').length, 1);
    const inspected = (await tools
      .find(({ name }) => name === 'inspect_hooks')!
      .impl({} as never, context)) as { active: unknown[] };
    assert.equal(inspected.active.length, 1);
    const snapshot = createHostHookComposition({
      stateRoot: root,
      extensions: fixture.runtime,
      runtimeEvents: { appendRuntimeEvent: async () => undefined },
    }).dispatcherFor(header(root));
    snapshot.prepareTurn('turn-snapshot');
    await tools
      .find(({ name }) => name === 'manage_hook')!
      .impl({ action: 'stop', extensionId: 'dev.maka.dynamic.policy' } as never, context);
    assert.equal(fixture.runtime.inspectHooks('session-1').length, 0);
    const retainedSnapshot = await snapshot.runPreToolUse(
      {
        schema_version: 1,
        hook_event_name: 'PreToolUse',
        session_id: 'session-1',
        turn_id: 'turn-snapshot',
        run_id: 'run-snapshot',
        tool_use_id: 'call-snapshot',
        tool_name: 'Bash',
        tool_input: {},
        cwd: root,
        permission_mode: 'ask',
        origin: 'provider',
      },
      new AbortController().signal,
      { invocationId: 'invocation-snapshot' },
    );
    assert.equal(retainedSnapshot.denied, true);
    snapshot.releaseTurn('turn-snapshot');
  } finally {
    await fixture.runtime.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

function createFixture(control: string) {
  const runtime = new HostExtensionRuntime();
  const hookStore = new HookPackageStore(control);
  const loader = new InstalledToolPackageExtensionLoader(
    new StaticTrustedToolExtensionLoader(),
    new ToolPackageStore(control),
    new UiPackageStore(control),
    hookStore,
  );
  const controller = new HostExtensionController(
    runtime,
    loader,
    new HostExtensionStateStore(control),
    () => undefined,
  );
  return { runtime, loader, controller, hookStore };
}

async function writeCombinedPackage(root: string, broken: boolean): Promise<void> {
  await mkdir(join(root, 'dist'), { recursive: true });
  await mkdir(join(root, 'documents'), { recursive: true });
  const id = 'dev.maka.hook.system';
  const version = broken ? '2.0.0' : '1.0.0';
  await writeFile(
    join(root, 'maka.extension.json'),
    JSON.stringify({ schemaVersion: 1, id, version, displayName: 'Hook System Test' }),
  );
  await writeFile(
    join(root, 'maka.tool.json'),
    JSON.stringify({
      schemaVersion: 1,
      id,
      version,
      entry: 'dist/index.mjs',
      tools: [
        {
          name: 'echo',
          description: 'Echo a value.',
          handler: 'echo',
          inputSchema: { type: 'object' },
          recoveryMode: 'replay_safe',
        },
      ],
      permissions: { workspace: 'none', network: false },
    }),
  );
  await writeFile(
    join(root, 'maka.ui.json'),
    JSON.stringify({
      schemaVersion: 1,
      id,
      version,
      ui: [
        {
          id: 'hook-status',
          surface: 'app.slot',
          slot: 'conversation.header',
          slots: [],
          priority: 0,
          document: 'documents/status.html',
        },
      ],
      permissions: { network: false, hostState: false, sessionAccess: false },
    }),
  );
  await writeFile(join(root, 'documents', 'status.html'), '<!doctype html><p>Hook active</p>');
  await writeFile(
    join(root, 'maka.hook.json'),
    JSON.stringify({
      schemaVersion: 1,
      id,
      version,
      entry: 'dist/index.mjs',
      hooks: [
        { id: 'prompt', event: 'UserPromptSubmit', mode: 'transform', handler: 'prompt' },
        { id: 'start', event: 'RunStart', mode: 'observe', handler: 'start' },
        {
          id: 'gate',
          event: 'PreToolUse',
          mode: 'gate',
          handler: broken ? 'missingGate' : 'gate',
          matcher: 'Bash',
        },
        { id: 'post', event: 'PostToolUse', mode: 'transform', handler: 'post' },
        { id: 'end', event: 'RunEnd', mode: 'observe', handler: 'end' },
      ],
      permissions: { workspace: 'none', network: false },
    }),
  );
  await writeFile(
    join(root, 'dist', 'index.mjs'),
    `export default {
      echo: async (input) => input,
      prompt: async (payload) => ({ payload: { text: '[hook] ' + payload.text } }),
      start: async () => undefined,
      gate: async () => ({ decision: 'deny', reason: 'blocked by extension' }),
      post: async (payload) => ({ payload: { result: { wrapped: payload.result } } }),
      end: async () => undefined
    };\n`,
  );
}

function header(root: string): SessionHeader {
  return {
    id: 'session-1',
    workspaceRoot: root,
    cwd: root,
    projectId: null,
    createdAt: 1,
    lastUsedAt: 1,
    name: 'Hook system test',
    titleIsManual: false,
    isFlagged: false,
    labels: [],
    isArchived: false,
    status: 'active',
    permissionMode: 'ask',
    collaborationMode: 'agent',
    connectionId: 'connection-1',
    modelId: 'model-1',
    thinkingLevel: 'medium',
  } as unknown as SessionHeader;
}

function toolContext(cwd: string): MakaToolContext {
  return {
    sessionId: 'session-1',
    runId: 'run-management',
    turnId: 'turn-management',
    cwd,
    permissionMode: 'ask',
    toolCallId: 'call-management',
    abortSignal: new AbortController().signal,
    emitOutput: () => undefined,
  };
}

let idCounter = 0;
function randomId(): string {
  idCounter += 1;
  return `hook-system-${idCounter}`;
}
