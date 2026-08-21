import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { IpcMain } from 'electron';
import {
  registerDesktopDiagnosticsIpc,
  type DesktopDiagnosticsIpcDeps,
} from '../desktop-diagnostics-ipc-main.js';
import {
  formatDesktopDiagnosticReport,
  parseDesktopDiagnosticInput,
} from '../main-process-diagnostics.js';

const environment = {
  appVersion: '0.1.8',
  buildMode: 'dev' as const,
  buildCommit: 'a'.repeat(40),
  electronVersion: '38.0.0',
  nodeVersion: '22.0.0',
  chromeVersion: '140.0.0',
  platform: 'linux' as const,
  arch: 'x64',
  osRelease: '6.6.0',
  locale: 'en-US',
  workspacePath: '/home/tester/.local/share/maka/workspaces/default',
  homePath: '/home/tester',
  processUptimeSeconds: 41.9,
};

const runtimeHostDiagnostics = {
  hostEpoch: 'epoch-1',
  compositionId: 'maka.interactive',
  compositionRevision: '1',
  compositionModules: ['interactive', 'execution'],
  state: 'ready' as const,
  connections: 1,
  activeOperations: 1,
  activeResidencies: 0,
  residencies: [],
  protocolVersion: 0,
  compatibilityEpoch: 16,
  pid: 42,
  processUptimeSeconds: 37,
  nodeVersion: '22.0.0',
  platform: 'linux' as const,
  arch: 'x64',
  osRelease: '6.6.0',
  logs: ['host log'],
};

test('formats one redacted Desktop and Runtime Host diagnostic report', () => {
  const report = formatDesktopDiagnosticReport(
    {
      surface: 'toast',
      title: 'Connection failed',
      hostTarget: 'default',
      description: 'api_key=sk-secretvalue123',
      rendererLocale: 'en-US',
    },
    environment,
    ['main log'],
    {
      ok: true,
      value: runtimeHostDiagnostics,
    },
    undefined,
    new Date('2026-08-09T00:00:00Z'),
  );

  assert.match(report, /Runtime Host[\s\S]*Recent Runtime Host logs \(1\)\nhost log/);
  assert.match(report, /Workspace: ~\/\.local\/share\/maka\/workspaces\/default/);
  assert.doesNotMatch(report, /sk-secretvalue123|\/home\/tester/);
});

test('bounds renderer diagnostic text and rejects unknown fields', () => {
  const input = parseDesktopDiagnosticInput({
    surface: 'toast',
    title: '🚀'.repeat(513),
    hostTarget: 'default',
    description: 'x'.repeat(30 * 1024),
  });

  assert.equal(input.surface, 'toast');
  assert.ok(Buffer.byteLength(input.title) <= 512);
  assert.ok(Buffer.byteLength(input.description ?? '') <= 24 * 1024);
  assert.match(input.title, /<diagnostic input truncated>$/);
  assert.throws(
    () => parseDesktopDiagnosticInput({
      surface: 'toast',
      title: 'error',
      hostTarget: 'default',
      extra: true,
    }),
    /Invalid Desktop diagnostic input/,
  );
});

test('accepts only a Runtime Host target and renderer context for capture', () => {
  assert.deepEqual(
    parseDesktopDiagnosticInput({
      surface: 'manual',
      hostTarget: 'default',
      rendererLocale: 'en-US',
    }),
    {
      surface: 'manual',
      hostTarget: 'default',
      rendererLocale: 'en-US',
    },
  );
  assert.deepEqual(
    parseDesktopDiagnosticInput({
      surface: 'manual',
      hostTarget: 'task',
    }),
    {
      surface: 'manual',
      hostTarget: 'task',
    },
  );
  assert.throws(
    () => parseDesktopDiagnosticInput({ surface: 'manual', title: 'Not an error' }),
    /Invalid Desktop diagnostic input/,
  );
  assert.throws(
    () => parseDesktopDiagnosticInput({
      surface: 'manual',
      hostTarget: { kind: 'target', hostId: '' },
    }),
    /Invalid Desktop diagnostic Runtime Host target/,
  );
});

test('formats a manual capture without inventing an error', () => {
  const report = formatDesktopDiagnosticReport(
    {
      surface: 'manual',
      hostTarget: 'default',
      rendererLocale: 'en-US',
    },
    environment,
    ['main log'],
    { ok: true, value: runtimeHostDiagnostics },
    undefined,
    new Date('2026-08-09T00:00:00Z'),
  );

  assert.match(report, /Capture\nSurface: manual/);
  assert.doesNotMatch(report, /\nError\n|\nTitle:/);
  assert.match(report, /Recent Runtime Host logs \(1\)\nhost log/);
});

test('copies Desktop diagnostics while Runtime Host is unavailable', async () => {
  type IpcHandler = Parameters<Pick<IpcMain, 'handle'>['handle']>[1];
  const handlers = new Map<string, IpcHandler>();
  let clipboard = '';
  registerDesktopDiagnosticsIpc({
    ipcMain: {
      handle(channel, handler) {
        handlers.set(channel, handler);
      },
    },
    environment: () => environment,
    mainLogs: () => ['main remained available'],
    resolveActiveRuntimeHost: () => undefined,
    resolveRuntimeHost: () => ({
      getDiagnostics: async () => {
        throw new Error('Runtime Host disconnected');
      },
      getTurnTrace: async () => undefined,
    }),
    writeClipboard: (value) => {
      clipboard = value;
    },
  });

  const handler = handlers.get('diagnostics:copyReport');
  assert.ok(handler);
  await handler(
    {} as never,
    { hostId: 'test-host', targetEpoch: 'test-target' },
    { surface: 'toast', title: 'Host failed', hostTarget: 'task' },
  );

  assert.match(clipboard, /Recent main-process logs \(1\)\nmain remained available/);
  assert.match(clipboard, /Diagnostics unavailable: Runtime Host disconnected/);
});

test('copies Desktop diagnostics while the scoped Host is reconnecting', async () => {
  type IpcHandler = Parameters<Pick<IpcMain, 'handle'>['handle']>[1];
  const handlers = new Map<string, IpcHandler>();
  let clipboard = '';
  registerDesktopDiagnosticsIpc({
    ipcMain: {
      handle(channel, handler) {
        handlers.set(channel, handler);
      },
    },
    environment: () => environment,
    mainLogs: () => ['main remained available'],
    resolveActiveRuntimeHost: () => undefined,
    resolveRuntimeHost: () => undefined,
    writeClipboard: (value) => {
      clipboard = value;
    },
  });

  const handler = handlers.get('diagnostics:copyReport');
  assert.ok(handler);
  await handler(
    {} as never,
    { hostId: 'test-host', targetEpoch: 'test-target' },
    { surface: 'toast', title: 'Host reconnecting', hostTarget: 'task' },
  );
  assert.match(clipboard, /Recent main-process logs \(1\)\nmain remained available/);
  assert.match(clipboard, /Diagnostics unavailable: Runtime Host is reconnecting/);
});

test('copies error diagnostics when the default Runtime Host cannot be resolved', async () => {
  type IpcHandler = Parameters<Pick<IpcMain, 'handle'>['handle']>[1];
  const handlers = new Map<string, IpcHandler>();
  let clipboard = '';
  registerDesktopDiagnosticsIpc({
    ipcMain: {
      handle(channel, handler) {
        handlers.set(channel, handler);
      },
    },
    environment: () => environment,
    mainLogs: () => ['main remained available'],
    resolveActiveRuntimeHost: () => {
      throw new Error('The default Runtime Host is unavailable');
    },
    resolveRuntimeHost: () => {
      throw new Error('Default capture must not resolve a task Host');
    },
    writeClipboard: (value) => {
      clipboard = value;
    },
  });

  const handler = handlers.get('diagnostics:copyReport');
  assert.ok(handler);
  await handler(
    {} as never,
    undefined,
    { surface: 'renderer_crash', title: 'Renderer failed', hostTarget: 'default' },
  );

  assert.match(clipboard, /Recent main-process logs \(1\)\nmain remained available/);
  assert.match(clipboard, /Diagnostics unavailable: Runtime Host is reconnecting/);
});

test('copies task error diagnostics without Host evidence when its scope is unavailable', async () => {
  type IpcHandler = Parameters<Pick<IpcMain, 'handle'>['handle']>[1];
  const handlers = new Map<string, IpcHandler>();
  let clipboard = '';
  registerDesktopDiagnosticsIpc({
    ipcMain: {
      handle(channel, handler) {
        handlers.set(channel, handler);
      },
    },
    environment: () => environment,
    mainLogs: () => ['main remained available'],
    resolveActiveRuntimeHost: () => {
      throw new Error('Task capture must not fall back to the default Host');
    },
    resolveRuntimeHost: () => {
      throw new Error('An unavailable task must not resolve a Host');
    },
    writeClipboard: (value) => {
      clipboard = value;
    },
  });

  const handler = handlers.get('diagnostics:copyReport');
  assert.ok(handler);
  await handler(
    {} as never,
    undefined,
    {
      surface: 'toast',
      title: 'Task failed',
      hostTarget: 'task',
      execution: { sessionId: 'session-1', turnId: 'turn-1', eventId: 'event-1' },
    },
  );

  assert.match(clipboard, /Recent main-process logs \(1\)\nmain remained available/);
  assert.match(
    clipboard,
    /Diagnostics unavailable: Runtime Host for this task is unavailable/,
  );
  assert.match(clipboard, /Execution evidence unavailable: not queried/);
});

test('copies bounded evidence for the exact failed Turn', async () => {
  type IpcHandler = Parameters<Pick<IpcMain, 'handle'>['handle']>[1];
  const handlers = new Map<string, IpcHandler>();
  let clipboard = '';
  const runtime: ReturnType<DesktopDiagnosticsIpcDeps['resolveRuntimeHost']> = {
    getDiagnostics: async () => runtimeHostDiagnostics,
    getTurnTrace: async (sessionId: string, turnId: string) => {
      assert.equal(sessionId, 'session-1');
      assert.equal(turnId, 'turn-1');
      return {
        turnId,
        runId: 'run-1',
        startedAt: 1_000,
        endedAt: 4_501,
        durationMs: 3_501,
        steps: [
          {
            kind: 'model_call',
            id: 'call-1',
            turnId,
            runId: 'run-1',
            startedAt: 1_000,
            endedAt: 4_501,
            durationMs: 3_501,
            callKind: 'main',
            providerId: 'openrouter',
            modelId: 'openrouter/free',
            step: 0,
            attempts: [
              {
                attemptId: 'attempt-1',
                attempt: 0,
                status: 'failed',
                startedAt: 1_000,
                completedAt: 4_501,
                latencyMs: 3_501,
                errorClass: 'unknown',
                costBasis: 'unpriced',
                usageBasis: 'missing',
              },
            ],
            status: 'failed',
          },
          {
            kind: 'error',
            id: 'event-1',
            turnId,
            runId: 'run-1',
            startedAt: 4_501,
            message: 'No endpoints accepted the request',
          },
        ],
        failure: {
          code: 'model_call_failed',
          message: 'No endpoints accepted the request',
          attributedToStepId: 'call-1',
        },
      };
    },
  };
  registerDesktopDiagnosticsIpc({
    ipcMain: {
      handle(channel, handler) {
        handlers.set(channel, handler);
      },
    },
    environment: () => environment,
    mainLogs: () => [],
    resolveActiveRuntimeHost: () => undefined,
    resolveRuntimeHost: () => runtime,
    writeClipboard: (value) => {
      clipboard = value;
    },
  });

  const handler = handlers.get('diagnostics:copyReport');
  assert.ok(handler);
  await handler(
    {} as never,
    { hostId: 'test-host', targetEpoch: 'test-target' },
    {
      surface: 'toast',
      title: 'Conversation error',
      hostTarget: 'task',
      execution: { sessionId: 'session-1', turnId: 'turn-1', eventId: 'event-1' },
    },
  );

  assert.match(clipboard, /Runtime Host execution[\s\S]*Run: run-1/);
  assert.match(clipboard, /Failure message: No endpoints accepted the request/);
});

test('keeps every diagnostic read bound to the scoped Host during a switch', async () => {
  type IpcHandler = Parameters<Pick<IpcMain, 'handle'>['handle']>[1];
  const handlers = new Map<string, IpcHandler>();
  let activeHostId = 'host-a';
  let releaseDiagnostics!: () => void;
  const diagnosticsGate = new Promise<void>((resolve) => {
    releaseDiagnostics = resolve;
  });
  const traceReads: string[] = [];
  registerDesktopDiagnosticsIpc({
    ipcMain: {
      handle(channel, handler) {
        handlers.set(channel, handler);
      },
    },
    environment: () => environment,
    mainLogs: () => [],
    resolveActiveRuntimeHost: () => undefined,
    resolveRuntimeHost: (scope) => {
      assert.equal(scope.hostId, activeHostId);
      assert.equal(scope.targetEpoch, 'target-a');
      const boundHostId = activeHostId;
      return {
        getDiagnostics: async () => {
          await diagnosticsGate;
          return runtimeHostDiagnostics;
        },
        getTurnTrace: async () => {
          traceReads.push(boundHostId);
          return undefined;
        },
      };
    },
    writeClipboard() {},
  });

  const handler = handlers.get('diagnostics:copyReport');
  assert.ok(handler);
  const copying = handler(
    {} as never,
    { hostId: 'host-a', targetEpoch: 'target-a' },
    {
      surface: 'toast',
      title: 'Conversation error',
      hostTarget: 'task',
      execution: {
        sessionId: 'shared-session',
        turnId: 'shared-turn',
        eventId: 'shared-event',
      },
    },
  );
  activeHostId = 'host-b';
  releaseDiagnostics();

  await copying;
  assert.deepEqual(traceReads, ['host-a']);
});

test('copies manual Desktop diagnostics without an active Runtime Host', async () => {
  type IpcHandler = Parameters<Pick<IpcMain, 'handle'>['handle']>[1];
  const handlers = new Map<string, IpcHandler>();
  let clipboard = '';
  registerDesktopDiagnosticsIpc({
    ipcMain: {
      handle(channel, handler) {
        handlers.set(channel, handler);
      },
    },
    environment: () => environment,
    mainLogs: () => ['main remained available'],
    resolveActiveRuntimeHost: () => undefined,
    resolveRuntimeHost: () => {
      throw new Error('Manual capture must not require a renderer-provided Host scope');
    },
    writeClipboard: (value) => {
      clipboard = value;
    },
  });

  const handler = handlers.get('diagnostics:copyReport');
  assert.ok(handler);
  await handler(
    {} as never,
    undefined,
    {
      surface: 'manual',
      hostTarget: 'default',
      rendererLocale: 'en-US',
    },
  );
  assert.match(clipboard, /Capture\nSurface: manual/);
  assert.match(clipboard, /Recent main-process logs \(1\)\nmain remained available/);
  assert.match(clipboard, /Diagnostics unavailable: Runtime Host is unavailable/);
});

test('copies diagnostics from the Runtime Host that owns the current task', async () => {
  type IpcHandler = Parameters<Pick<IpcMain, 'handle'>['handle']>[1];
  const handlers = new Map<string, IpcHandler>();
  let clipboard = '';
  registerDesktopDiagnosticsIpc({
    ipcMain: {
      handle(channel, handler) {
        handlers.set(channel, handler);
      },
    },
    environment: () => environment,
    mainLogs: () => [],
    resolveActiveRuntimeHost: () => {
      throw new Error('Targeted capture must not fall back to the default Host');
    },
    resolveRuntimeHost: (scope) => {
      assert.deepEqual(scope, { hostId: 'remote-host', targetEpoch: 'remote-target' });
      return {
        getDiagnostics: async () => ({
          ...runtimeHostDiagnostics,
          logs: ['remote task host log'],
        }),
        getTurnTrace: async () => undefined,
      };
    },
    writeClipboard: (value) => {
      clipboard = value;
    },
  });

  const handler = handlers.get('diagnostics:copyReport');
  assert.ok(handler);
  await handler(
    {} as never,
    { hostId: 'remote-host', targetEpoch: 'remote-target' },
    {
      surface: 'manual',
      hostTarget: 'task',
    },
  );
  assert.match(clipboard, /Recent Runtime Host logs \(1\)\nremote task host log/);
});

test('keeps targeted manual capture Desktop-only when the task Host is unavailable', async () => {
  type IpcHandler = Parameters<Pick<IpcMain, 'handle'>['handle']>[1];
  const handlers = new Map<string, IpcHandler>();
  let clipboard = '';
  registerDesktopDiagnosticsIpc({
    ipcMain: {
      handle(channel, handler) {
        handlers.set(channel, handler);
      },
    },
    environment: () => environment,
    mainLogs: () => ['main remained available'],
    resolveActiveRuntimeHost: () => {
      throw new Error('Targeted capture must not fall back to the default Host');
    },
    resolveRuntimeHost: () => {
      throw new Error('The task Host disappeared after scope resolution');
    },
    writeClipboard: (value) => {
      clipboard = value;
    },
  });

  const handler = handlers.get('diagnostics:copyReport');
  assert.ok(handler);
  await handler(
    {} as never,
    undefined,
    {
      surface: 'manual',
      hostTarget: 'task',
    },
  );
  assert.match(
    clipboard,
    /Diagnostics unavailable: Runtime Host for this task is unavailable/,
  );
  await handler(
    {} as never,
    { hostId: 'remote-host', targetEpoch: 'stale-target' },
    {
      surface: 'manual',
      hostTarget: 'task',
    },
  );
  assert.match(clipboard, /Recent main-process logs \(1\)\nmain remained available/);
  assert.match(
    clipboard,
    /Diagnostics unavailable: Runtime Host for this task is unavailable/,
  );
});

test('rejects a default diagnostic request that carries a task Host scope', async () => {
  type IpcHandler = Parameters<Pick<IpcMain, 'handle'>['handle']>[1];
  const handlers = new Map<string, IpcHandler>();
  registerDesktopDiagnosticsIpc({
    ipcMain: {
      handle(channel, handler) {
        handlers.set(channel, handler);
      },
    },
    environment: () => environment,
    mainLogs: () => [],
    resolveActiveRuntimeHost: () => undefined,
    resolveRuntimeHost: () => {
      throw new Error('Default capture must be rejected before Host resolution');
    },
    writeClipboard() {
      throw new Error('Default capture must be rejected before clipboard output');
    },
  });

  const handler = handlers.get('diagnostics:copyReport');
  assert.ok(handler);
  await assert.rejects(
    handler(
      {} as never,
      { hostId: 'default-host', targetEpoch: 'default-target' },
      {
        surface: 'manual',
        hostTarget: 'default',
      },
    ),
    /Default Desktop diagnostics must not carry a Host scope/,
  );
});

test('rejects the copy request when the main-process clipboard write fails', async () => {
  type IpcHandler = Parameters<Pick<IpcMain, 'handle'>['handle']>[1];
  const handlers = new Map<string, IpcHandler>();
  registerDesktopDiagnosticsIpc({
    ipcMain: {
      handle(channel, handler) {
        handlers.set(channel, handler);
      },
    },
    environment: () => environment,
    mainLogs: () => [],
    resolveActiveRuntimeHost: () => undefined,
    resolveRuntimeHost: () => undefined,
    writeClipboard() {
      throw new Error('System clipboard unavailable');
    },
  });

  const handler = handlers.get('diagnostics:copyReport');
  assert.ok(handler);
  await assert.rejects(
    handler(
      {} as never,
      undefined,
      { surface: 'manual', hostTarget: 'default' },
    ),
    /System clipboard unavailable/,
  );
});
