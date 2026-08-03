import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { registerSubscriptionIpc } from '../subscription-ipc-main.js';

type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>;

function registerClaudeHandlers(serviceCalls: string[]): Map<string, Handler> {
  const handlers = new Map<string, Handler>();
  const record = (method: string, result: unknown) => async () => {
    serviceCalls.push(method);
    return result;
  };
  const deps = {
    ipcMain: {
      handle(channel: string, handler: Handler) {
        handlers.set(channel, handler);
      },
    },
    claudeSubscription: {
      getAuthorizationUrl: record('getAuthorizationUrl', {
        authRequestId: 'request-id',
        stateHint: 'state',
      }),
      openAuthorizationUrl: record('openAuthorizationUrl', { ok: true }),
      completeAuthorization: record('completeAuthorization', { ok: true }),
      refreshQuota: record('refreshQuota', { ok: true }),
      refreshTokens: record('refreshTokens', { ok: true }),
    },
    syncClaudeSubscriptionConnection: async () => null,
    emitConnectionListChanged: () => {},
  } as unknown as Parameters<typeof registerSubscriptionIpc>[0];

  registerSubscriptionIpc(deps);
  return handlers;
}

describe('Claude subscription experimental IPC gate', () => {
  test('fails closed before every sensitive service action when disabled', async () => {
    const previousExperimental = process.env.MAKA_CLAUDE_SUBSCRIPTION_EXPERIMENTAL;
    process.env.MAKA_CLAUDE_SUBSCRIPTION_EXPERIMENTAL = '0';
    const serviceCalls: string[] = [];
    try {
      const handlers = registerClaudeHandlers(serviceCalls);
      const cases: ReadonlyArray<{ channel: string; args: unknown[] }> = [
        { channel: 'claude-subscription:get-auth-url', args: [] },
        { channel: 'claude-subscription:open-auth-url', args: ['request-id'] },
        {
          channel: 'claude-subscription:complete-authorization',
          args: ['request-id', 'authorization-code'],
        },
        { channel: 'claude-subscription:refresh-quota', args: [] },
        { channel: 'claude-subscription:refresh-tokens', args: [] },
      ];

      for (const { channel, args } of cases) {
        const handler = handlers.get(channel);
        assert.ok(handler, `${channel} should be registered`);
        const result = await handler({}, ...args);
        assert.equal((result as { ok?: unknown }).ok, false, `${channel} should fail`);
        assert.equal(
          (result as { reason?: unknown }).reason,
          'experimental_disabled',
          `${channel} should expose the disabled reason`,
        );
      }
      assert.deepEqual(serviceCalls, []);
    } finally {
      if (previousExperimental === undefined) {
        delete process.env.MAKA_CLAUDE_SUBSCRIPTION_EXPERIMENTAL;
      } else {
        process.env.MAKA_CLAUDE_SUBSCRIPTION_EXPERIMENTAL = previousExperimental;
      }
    }
  });

  test('delegates a representative auth action when the opt-out flag is unset', async () => {
    const previousExperimental = process.env.MAKA_CLAUDE_SUBSCRIPTION_EXPERIMENTAL;
    delete process.env.MAKA_CLAUDE_SUBSCRIPTION_EXPERIMENTAL;
    const serviceCalls: string[] = [];
    try {
      const handlers = registerClaudeHandlers(serviceCalls);
      const getAuthUrl = handlers.get('claude-subscription:get-auth-url');
      assert.ok(getAuthUrl);

      assert.deepEqual(await getAuthUrl({}), {
        authRequestId: 'request-id',
        stateHint: 'state',
      });
      assert.deepEqual(serviceCalls, ['getAuthorizationUrl']);
    } finally {
      if (previousExperimental === undefined) {
        delete process.env.MAKA_CLAUDE_SUBSCRIPTION_EXPERIMENTAL;
      } else {
        process.env.MAKA_CLAUDE_SUBSCRIPTION_EXPERIMENTAL = previousExperimental;
      }
    }
  });
});
