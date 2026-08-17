import assert from 'node:assert/strict';
import { test } from 'node:test';
import { z } from 'zod';
import type { MakaTool } from '@maka/runtime/tool-runtime';
import { HostExtensionRuntime } from '../server/extension-runtime.js';

test('Host Extension authority owns trusted Tool lifecycle and close cleanup', async () => {
  const extensions = new HostExtensionRuntime({
    protectedToolNames: () => ['Read'],
  });
  const weatherV1 = tool('Weather', 1);
  const weatherV2 = tool('Weather', 2);

  await extensions.installTrustedToolRevision({
    extensionId: 'weather',
    revision: '1',
    tools: [weatherV1],
  });
  await extensions.installTrustedToolRevision({
    extensionId: 'weather',
    revision: '2',
    tools: [weatherV2],
  });
  await extensions.activate({
    bindingId: 'weather-binding',
    scopeId: 'session-a',
    extensionId: 'weather',
    revision: '1',
  });

  assert.deepEqual(
    extensions.resolveTools('session-a', [tool('Read', 0)]).map(({ name }) => name),
    ['Read', 'Weather'],
  );
  assert.equal(extensions.resolveTools('session-a', [tool('Read', 0)])[1]?.impl, weatherV1.impl);

  await extensions.update('weather-binding', '2');
  assert.equal(extensions.resolveTools('session-a', [tool('Read', 0)])[1]?.impl, weatherV2.impl);
  assert.equal(extensions.composition('session-a').entries[0]?.revision, '2');

  extensions.beginDrain();
  assert.throws(
    () =>
      extensions.installTrustedToolRevision({
        extensionId: 'late',
        revision: '1',
        tools: [tool('Late', 1)],
      }),
    /draining/,
  );
  // Read-only resolution remains available while already-admitted work drains.
  assert.equal(extensions.resolveTools('session-a', []).length, 1);

  await extensions.close();
  assert.deepEqual(extensions.inspectTools('session-a'), []);
  assert.deepEqual(extensions.installedRevisions(), []);
  assert.throws(() => extensions.resolveTools('session-a', []), /closed/);
  await extensions.close();
});

test('Host Extension close retries lifecycle cleanup before uninstalling revisions', async () => {
  const extensions = new HostExtensionRuntime();
  let cleanupAttempts = 0;
  await extensions.install({
    extensionId: 'retryable',
    revision: '1',
    prepare: () => ({
      activate: (context) => {
        context.ownEffect('retryable-cleanup', () => {
          cleanupAttempts += 1;
          if (cleanupAttempts === 1) throw new Error('cleanup unavailable');
        });
      },
    }),
  });
  await extensions.activate({
    bindingId: 'retryable-binding',
    scopeId: 'session-retry',
    extensionId: 'retryable',
    revision: '1',
  });

  await assert.rejects(extensions.close(), /Unable to close Runtime Host Extension authority/);
  assert.deepEqual(extensions.installedRevisions(), [{ extensionId: 'retryable', revision: '1' }]);

  await extensions.close();
  assert.equal(cleanupAttempts, 2);
  assert.deepEqual(extensions.installedRevisions(), []);
});

test('core Agent seams preserve the zero-listener hot path without serializing payloads', async () => {
  const extensions = new HostExtensionRuntime();
  const payload = { prompt: 'BASE', hostOnly: Symbol('host-only') };
  const dispatched = await extensions.dispatchCoreEvent(
    'session-empty',
    'maka.system-prompt.assemble',
    payload,
    {
      sessionId: 'session-empty',
      runId: 'run-empty',
      turnId: 'turn-empty',
      cwd: process.cwd(),
      permissionMode: 'default',
      origin: 'host',
      configuration: Object.freeze({}),
      signal: new AbortController().signal,
    },
  );

  assert.equal(dispatched.listenerCount, 0);
  assert.equal(dispatched.result, payload);
  await extensions.close();
});

test('core Agent seams and typed Services share lifecycle-owned dispatch', async () => {
  const extensions = new HostExtensionRuntime();
  await extensions.installToolRevision({
    extensionId: 'runtime-policy',
    revision: '1',
    toolNames: [],
    eventContributionIds: ['core-transform'],
    serviceContributionIds: ['runtime-policy.echo'],
    prepare: async () => ({
      tools: [],
      listeners: [
        {
          id: 'append-policy',
          event: 'maka.system-prompt.assemble',
          handler: 'appendPolicy',
          priority: 10,
          timeoutMs: 1_000,
          invoke: async (payload) => ({
            ...(payload as Record<string, unknown>),
            prompt: `${String((payload as { prompt?: unknown }).prompt)}\nPOLICY`,
          }),
        },
      ],
      services: [
        {
          name: 'runtime-policy.echo',
          version: '1.0.0',
          description: 'Echo a typed value.',
          methods: [
            {
              name: 'read',
              description: '',
              handler: 'read',
              inputSchema: {
                type: 'object',
                properties: { value: { type: 'string' } },
                required: ['value'],
                additionalProperties: false,
              },
              outputSchema: {
                type: 'object',
                properties: { value: { type: 'string' } },
                required: ['value'],
                additionalProperties: false,
              },
              timeoutMs: 1_000,
            },
          ],
          invoke: async (_method, input) => input,
        },
      ],
    }),
  });
  await extensions.activate({
    bindingId: 'runtime-policy-binding',
    scopeId: 'session-core',
    extensionId: 'runtime-policy',
    revision: '1',
  });
  const context = {
    sessionId: 'session-core',
    runId: 'run-core',
    turnId: 'turn-core',
    cwd: process.cwd(),
    permissionMode: 'default',
    origin: 'host' as const,
    configuration: Object.freeze({}),
    signal: new AbortController().signal,
  };
  const dispatched = await extensions.dispatchCoreEvent(
    'session-core',
    'maka.system-prompt.assemble',
    { prompt: 'BASE' },
    context,
  );
  assert.deepEqual(dispatched.result, { prompt: 'BASE\nPOLICY' });
  assert.deepEqual(
    await extensions.callService(
      'session-core',
      'runtime-policy.echo',
      'read',
      { value: 'ok' },
      { ...context, callerExtensionId: 'runtime-policy' },
    ),
    { value: 'ok' },
  );
  await assert.rejects(
    extensions.callService(
      'session-core',
      'runtime-policy.echo',
      'read',
      { value: 1 },
      { ...context, callerExtensionId: 'runtime-policy' },
    ),
    /input does not match/u,
  );
  await extensions.close();
});

function tool(name: string, revision: number): MakaTool {
  return {
    name,
    description: `${name} revision ${revision}`,
    parameters: z.object({}),
    impl: async () => ({ revision }),
  };
}
