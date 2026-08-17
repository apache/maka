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
  const unhandledBail = await extensions.dispatchCoreEvent(
    'session-empty',
    'maka.agent.request-error',
    { failure: 'terminal', hostOnly: Symbol('host-only') },
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
  assert.equal(unhandledBail.listenerCount, 0);
  assert.equal(unhandledBail.result, undefined);
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
            {
              name: 'badOutput',
              description: 'Return a deliberately invalid output.',
              handler: 'badOutput',
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
          invoke: async (method, input) => (method === 'badOutput' ? { value: 1 } : input),
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
  await assert.rejects(
    extensions.callService(
      'session-core',
      'runtime-policy.echo',
      'badOutput',
      { value: 'ok' },
      { ...context, callerExtensionId: 'runtime-policy' },
    ),
    /output does not match/u,
  );
  await extensions.close();
});

test('trusted core middleware wraps the live Tool and LLM continuations', async () => {
  const extensions = new HostExtensionRuntime();
  const order: string[] = [];
  await extensions.installToolRevision({
    extensionId: 'around-runtime',
    revision: '1',
    toolNames: [],
    eventContributionIds: ['tools-around', 'llm-around'],
    prepare: async () => ({
      tools: [],
      listeners: [
        {
          id: 'tools-around',
          event: 'maka.tools.execute',
          handler: 'toolsAround',
          priority: 20,
          timeoutMs: 1_000,
          invoke: async (payload, _context, next) => {
            order.push('tool:before');
            const result = await next?.({ ...(payload as object), toolInput: { value: 2 } });
            order.push('tool:after');
            return { ...(result as object), wrapped: true };
          },
        },
        {
          id: 'llm-around',
          event: 'maka.llm.stream',
          handler: 'llmAround',
          priority: 20,
          timeoutMs: 1_000,
          invoke: async (payload, _context, next) => {
            order.push('llm:before');
            const result = await next?.(payload);
            order.push('llm:after');
            return result;
          },
        },
      ],
    }),
  });
  await extensions.activate({
    bindingId: 'around-runtime-binding',
    scopeId: 'session-around',
    extensionId: 'around-runtime',
    revision: '1',
  });
  const context = {
    sessionId: 'session-around',
    runId: 'run-around',
    turnId: 'turn-around',
    cwd: process.cwd(),
    permissionMode: 'default',
    origin: 'host' as const,
    configuration: Object.freeze({}),
    signal: new AbortController().signal,
  };
  const toolResult = await extensions.dispatchCoreMiddleware(
    'session-around',
    'maka.tools.execute',
    { toolName: 'Echo', toolInput: { value: 1 } },
    context,
    async (payload) => {
      order.push('tool:impl');
      return (payload as { toolInput: unknown }).toolInput;
    },
  );
  assert.deepEqual(toolResult, { value: 2, wrapped: true });

  const stream = { events: Symbol('live-stream') };
  assert.equal(
    await extensions.dispatchCoreMiddleware(
      'session-around',
      'maka.llm.stream',
      { request: Symbol('live-request') },
      context,
      async () => {
        order.push('llm:provider');
        return stream;
      },
    ),
    stream,
  );
  assert.deepEqual(order, [
    'tool:before',
    'tool:impl',
    'tool:after',
    'llm:before',
    'llm:provider',
    'llm:after',
  ]);
  await extensions.close();
});

test('custom Event modes honor priority, neutral bail, schemas, and lifecycle cleanup', async () => {
  const extensions = new HostExtensionRuntime();
  const calls: string[] = [];
  const objectSchema = {
    type: 'object',
    properties: { value: { type: 'number' } },
    required: ['value'],
    additionalProperties: false,
  } as const;
  await extensions.installToolRevision({
    extensionId: 'dispatch',
    revision: '1',
    toolNames: [],
    eventContributionIds: ['unhandled', 'serial', 'gate', 'transform'],
    prepare: async () => ({
      tools: [],
      events: [
        {
          name: 'dispatch.unhandled',
          description: 'An optionally answered query.',
          mode: 'bail',
          payloadSchema: objectSchema,
          resultSchema: {
            type: 'object',
            properties: { answer: { type: 'number' } },
            required: ['answer'],
            additionalProperties: false,
          },
        },
        {
          name: 'dispatch.serial',
          description: 'Ordered results.',
          mode: 'serial',
          payloadSchema: objectSchema,
          resultSchema: { type: 'number' },
        },
        {
          name: 'dispatch.gate',
          description: 'First denial wins.',
          mode: 'gate',
          payloadSchema: objectSchema,
        },
        {
          name: 'dispatch.transform',
          description: 'Schema-preserving transform.',
          mode: 'transform',
          payloadSchema: objectSchema,
        },
      ],
      listeners: [
        listener('serial-low', 'dispatch.serial', 0, async () => {
          calls.push('serial-low');
          return 0;
        }),
        listener('serial-high', 'dispatch.serial', 100, async () => {
          calls.push('serial-high');
          return 100;
        }),
        listener('gate-allow', 'dispatch.gate', 100, async () => ({ decision: 'allow' })),
        listener('gate-deny', 'dispatch.gate', 50, async () => ({
          decision: 'deny',
          reason: 'policy denied',
        })),
        listener('gate-unreached', 'dispatch.gate', 0, async () => ({ decision: 'allow' })),
        listener('invalid-transform', 'dispatch.transform', 0, async () => ({ value: 'wrong' })),
      ],
    }),
  });
  await extensions.activate({
    bindingId: 'dispatch-binding',
    scopeId: 'session-dispatch',
    extensionId: 'dispatch',
    revision: '1',
  });
  const context = extensionContext('session-dispatch');

  const unhandled = await extensions.emitEvent(
    'session-dispatch',
    'dispatch.unhandled',
    { value: 1 },
    context,
  );
  assert.equal(unhandled.listenerCount, 0);
  assert.equal(Object.hasOwn(unhandled, 'result'), false);

  const serial = await extensions.emitEvent(
    'session-dispatch',
    'dispatch.serial',
    { value: 1 },
    context,
  );
  assert.deepEqual(serial.result, [100, 0]);
  assert.deepEqual(calls, ['serial-high', 'serial-low']);

  const gate = await extensions.emitEvent(
    'session-dispatch',
    'dispatch.gate',
    { value: 1 },
    context,
  );
  assert.equal(gate.listenerCount, 3);
  assert.equal(gate.delivered, 2);
  assert.deepEqual(gate.result, { decision: 'deny', reason: 'policy denied' });

  await assert.rejects(
    extensions.emitEvent('session-dispatch', 'dispatch.transform', { value: 1 }, context),
    /result does not match/u,
  );

  await extensions.stop('dispatch-binding');
  await assert.rejects(
    extensions.emitEvent('session-dispatch', 'dispatch.serial', { value: 1 }, context),
    /event is not defined/u,
  );
  assert.deepEqual(extensions.inspectEventListeners('session-dispatch'), []);
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

function listener(
  id: string,
  event: string,
  priority: number,
  invoke: (payload: unknown) => Promise<unknown>,
) {
  return { id, event, handler: id, priority, timeoutMs: 1_000, invoke };
}

function extensionContext(sessionId: string) {
  return {
    sessionId,
    runId: 'run-extension',
    turnId: 'turn-extension',
    cwd: process.cwd(),
    permissionMode: 'default',
    origin: 'host' as const,
    configuration: Object.freeze({}),
    signal: new AbortController().signal,
  };
}
