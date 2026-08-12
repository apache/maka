import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDefaultRuntimePolicy } from '@maka/core/runtime-policy';
import type { MakaToolContext } from '@maka/runtime/tool-runtime';
import type { ProxiedFetchProxy } from '@maka/runtime/network/scoped-fetch-transport';
import type {
  ResolveWebFetchExecutionResult,
  RuntimePolicyOperationCoordinator,
} from '@maka/storage/runtime-policy-stores';
import { createHostWebFetchTool } from '../server/web-fetch-tool.js';

test('Host WebFetch uses the resolved proxy snapshot and closes its transport', async () => {
  const networkProxy = {
    ...createDefaultRuntimePolicy().networkProxy,
    enabled: true,
    protocol: 'http' as const,
    host: 'proxy.example',
    port: 8080,
    authEnabled: true,
    username: 'proxy-user',
    bypassList: ['direct.example'],
  };
  let proxy: ProxiedFetchProxy | null | undefined;
  let closed = 0;
  const tool = createHostWebFetchTool({
    policy: resolver({
      kind: 'ready',
      networkProxy,
      secretMaterial: {
        networkProxy: {
          locator: { scope: 'network_proxy', kind: 'password' },
          credentialId: 'proxy-credential',
          revision: 1,
          secret: 'proxy-secret',
        },
      },
    }),
    createFetchTransport: (candidate) => {
      proxy = candidate;
      return {
        fetch: async () =>
          new Response('fetched body', { headers: { 'content-type': 'text/plain' } }),
        close: async () => {
          closed += 1;
        },
      };
    },
  });

  const result = await tool.impl({ url: 'https://example.com/page' }, context());

  assert.equal(result, 'fetched body');
  assert.deepEqual(proxy, {
    enabled: true,
    type: 'http',
    host: 'proxy.example',
    port: 8080,
    username: 'proxy-user',
    password: 'proxy-secret',
    bypassList: [...networkProxy.bypassList, ...networkProxy.autoBypassDomains],
  });
  assert.equal(closed, 1);
});

test('Host WebFetch fails closed before transport creation in privacy mode', async () => {
  let transportCreated = false;
  const tool = createHostWebFetchTool({
    policy: resolver({ kind: 'privacy_mode' }),
    createFetchTransport: () => {
      transportCreated = true;
      throw new Error('transport must not be created');
    },
  });

  await assert.rejects(
    async () => tool.impl({ url: 'https://example.com/page' }, context()),
    /disabled while privacy mode is active/i,
  );
  assert.equal(transportCreated, false);
});

test('Host WebFetch fails closed before transport creation when proxy credentials are missing', async () => {
  let transportCreated = false;
  const tool = createHostWebFetchTool({
    policy: resolver({
      kind: 'credential_not_configured',
      status: {
        locator: { scope: 'network_proxy', kind: 'password' },
        configured: false,
        credentialId: null,
        revision: null,
        updatedAt: null,
      },
    }),
    createFetchTransport: () => {
      transportCreated = true;
      throw new Error('transport must not be created');
    },
  });

  await assert.rejects(
    async () => tool.impl({ url: 'https://example.com/page' }, context()),
    /configure the network proxy credential/i,
  );
  assert.equal(transportCreated, false);
});

test('Host WebFetch closes its transport when the owning turn is cancelled', async () => {
  const abort = new AbortController();
  let closed = 0;
  let markFetchStarted!: () => void;
  const fetchStarted = new Promise<void>((resolve) => {
    markFetchStarted = resolve;
  });
  const tool = createHostWebFetchTool({
    policy: resolver({
      kind: 'ready',
      networkProxy: createDefaultRuntimePolicy().networkProxy,
      secretMaterial: {},
    }),
    createFetchTransport: () => ({
      fetch: async (_url, init) =>
        await new Promise<Response>((_resolve, reject) => {
          markFetchStarted();
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
            once: true,
          });
        }),
      close: async () => {
        closed += 1;
      },
    }),
  });

  const result = tool.impl({ url: 'https://example.com/page' }, context(abort.signal));
  await fetchStarted;
  abort.abort(new Error('turn cancelled'));

  await assert.rejects(async () => result, /turn cancelled/i);
  assert.equal(closed, 1);
});

function resolver(
  result: ResolveWebFetchExecutionResult,
): Pick<RuntimePolicyOperationCoordinator, 'resolveWebFetchExecution'> {
  return { resolveWebFetchExecution: async () => result };
}

function context(abortSignal = new AbortController().signal): MakaToolContext {
  return {
    sessionId: 'session-1',
    turnId: 'turn-1',
    cwd: '/tmp',
    toolCallId: 'tool-1',
    abortSignal,
    emitOutput: () => {},
  };
}
