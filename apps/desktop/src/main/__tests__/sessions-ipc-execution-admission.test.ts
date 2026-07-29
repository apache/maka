import assert from 'node:assert/strict';
import { test } from 'node:test';
import { registerSessionExecutionIpc } from '../session-execution-ipc-main.js';

test('every resumptive session IPC stops before runtime execution when admission rejects', async () => {
  const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
  const runtimeCalls: string[] = [];
  const runtime = new Proxy(
    {},
    {
      get(_target, property) {
        return () => {
          runtimeCalls.push(String(property));
          throw new Error(`runtime execution reached: ${String(property)}`);
        };
      },
    },
  );
  registerSessionExecutionIpc({
    ipcMain: {
      handle(
        channel: string,
        handler: Parameters<import('electron').IpcMain['handle']>[1],
      ) {
        handlers.set(channel, handler as (...args: unknown[]) => Promise<unknown>);
      },
    },
    runtime: runtime as never,
    ensureSessionCanSend: async () => {
      throw new Error('External execution boundary is not interactive');
    },
    ensureSessionWorkspaceAvailable: async () => {
      throw new Error('workspace admission must not run');
    },
    streamEvents: async () => {
      throw new Error('streaming must not run');
    },
    emitModeChanged: () => {
      throw new Error('mode event must not emit');
    },
  });

  const cases: Array<{ channel: string; args: unknown[] }> = [
    { channel: 'sessions:compact', args: ['session-1'] },
    { channel: 'sessions:resumeLatest', args: ['session-1'] },
    {
      channel: 'sessions:regenerateTurn',
      args: ['session-1', { sourceTurnId: 'turn-1' }],
    },
    {
      channel: 'plan-mode:approve',
      args: [
        'session-1',
        { proposalId: 'proposal-1', expectedRevision: 1, expectedStoreVersion: 1 },
      ],
    },
    { channel: 'plan-mode:resume', args: ['session-1', 'execution-1'] },
  ];

  for (const { channel, args } of cases) {
    const handler = handlers.get(channel);
    assert.ok(handler, `${channel} must be registered`);
    await assert.rejects(() => handler({}, ...args), /External execution boundary/);
  }
  assert.deepEqual(runtimeCalls, []);
});
