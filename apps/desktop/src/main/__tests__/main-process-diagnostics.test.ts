import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { IpcMain } from 'electron';
import {
  registerDesktopDiagnosticsIpc,
  type DesktopDiagnosticsIpcDeps,
} from '../desktop-diagnostics-ipc-main.js';
import {
  formatDesktopErrorDiagnosticReport,
  parseDesktopErrorDiagnosticInput,
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
  const report = formatDesktopErrorDiagnosticReport(
    {
      surface: 'toast',
      title: 'Connection failed',
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
  const input = parseDesktopErrorDiagnosticInput({
    surface: 'toast',
    title: '🚀'.repeat(513),
    description: 'x'.repeat(30 * 1024),
  });

  assert.ok(Buffer.byteLength(input.title) <= 512);
  assert.ok(Buffer.byteLength(input.description ?? '') <= 24 * 1024);
  assert.match(input.title, /<diagnostic input truncated>$/);
  assert.throws(
    () => parseDesktopErrorDiagnosticInput({ surface: 'toast', title: 'error', extra: true }),
    /Invalid Desktop diagnostic input/,
  );
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

  const handler = handlers.get('diagnostics:copyErrorReport');
  assert.ok(handler);
  const result = await handler(
    {} as never,
    { hostId: 'test-host', targetEpoch: 'test-target' },
    { surface: 'toast', title: 'Host failed' },
  );

  assert.deepEqual(result, { ok: true });
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
    resolveRuntimeHost: () => undefined,
    writeClipboard: (value) => {
      clipboard = value;
    },
  });

  const handler = handlers.get('diagnostics:copyErrorReport');
  assert.ok(handler);
  assert.deepEqual(
    await handler(
      {} as never,
      { hostId: 'test-host', targetEpoch: 'test-target' },
      { surface: 'toast', title: 'Host reconnecting' },
    ),
    { ok: true },
  );
  assert.match(clipboard, /Recent main-process logs \(1\)\nmain remained available/);
  assert.match(clipboard, /Diagnostics unavailable: Runtime Host is reconnecting/);
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
        totals: {
          durationMs: 3_501,
          modelAttempts: 1,
          retries: 0,
          compactions: 0,
          inputTokens: 0,
          outputTokens: 0,
          unpricedAttempts: 1,
        },
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
    resolveRuntimeHost: () => runtime,
    writeClipboard: (value) => {
      clipboard = value;
    },
  });

  const handler = handlers.get('diagnostics:copyErrorReport');
  assert.ok(handler);
  const result = await handler(
    {} as never,
    { hostId: 'test-host', targetEpoch: 'test-target' },
    {
      surface: 'toast',
      title: 'Conversation error',
      execution: { sessionId: 'session-1', turnId: 'turn-1', eventId: 'event-1' },
    },
  );

  assert.deepEqual(result, { ok: true });
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

  const handler = handlers.get('diagnostics:copyErrorReport');
  assert.ok(handler);
  const copying = handler(
    {} as never,
    { hostId: 'host-a', targetEpoch: 'target-a' },
    {
      surface: 'toast',
      title: 'Conversation error',
      execution: {
        sessionId: 'shared-session',
        turnId: 'shared-turn',
        eventId: 'shared-event',
      },
    },
  );
  activeHostId = 'host-b';
  releaseDiagnostics();

  assert.deepEqual(await copying, { ok: true });
  assert.deepEqual(traceReads, ['host-a']);
});
