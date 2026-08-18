import assert from 'node:assert/strict';
import { test } from 'node:test';
import { z } from 'zod';
import { HostExtensionRuntime } from '../server/extension-runtime.js';

test('one Cordis package owns Tool, UI, and Hook contributions together', async () => {
  const runtime = new HostExtensionRuntime();
  const observed: unknown[] = [];
  await runtime.installToolRevision({
    extensionId: 'fixture.combined',
    revision: 'r1',
    toolNames: ['fixture_combined'],
    ui: [
      {
        id: 'fixture-root',
        surface: 'app.root',
        slots: ['fixture.detail'],
        priority: 10,
        document: '<!doctype html><title>fixture</title>',
        network: false,
      },
      {
        id: 'fixture-detail',
        surface: 'app.slot',
        slot: 'fixture.detail',
        priority: 10,
        document: '<!doctype html><title>detail</title>',
        network: false,
      },
    ],
    eventContributionIds: ['fixture.combined.changed', 'capture'],
    load: async () => ({
      tools: [
        {
          name: 'fixture_combined',
          description: 'fixture',
          parameters: z.object({ value: z.number() }),
          impl: async ({ value }: { value: number }) => value + 1,
        },
      ],
      events: [
        {
          name: 'fixture.combined.changed',
          description: 'fixture changed',
          payloadSchema: {
            type: 'object',
            properties: { value: { type: 'number' } },
            required: ['value'],
          },
        },
      ],
      listeners: [
        {
          id: 'capture',
          event: 'fixture.combined.changed',
          handler: 'capture',
          priority: 0,
          timeoutMs: 1_000,
          invoke: async (payload: unknown) => {
            observed.push(payload);
          },
        },
      ],
    }),
  });
  await runtime.activate({
    bindingId: 'combined-entry',
    scopeId: 'session-one',
    extensionId: 'fixture.combined',
    revision: 'r1',
  });
  assert.equal(runtime.inspectTools('session-one').length, 1);
  assert.equal(runtime.inspectUi('session-one').length, 2);
  assert.equal(runtime.inspectEvents('session-one').length, 1);
  assert.equal(runtime.inspectEventListeners('session-one').length, 1);
  await runtime.emitEvent(
    'session-one',
    'fixture.combined.changed',
    { value: 3 },
    invocationContext(),
  );
  assert.deepEqual(observed, [{ value: 3 }]);
  await runtime.stop('combined-entry');
  assert.equal(runtime.inspectTools('session-one').length, 0);
  assert.equal(runtime.inspectUi('session-one').length, 0);
  assert.equal(runtime.inspectEventListeners('session-one').length, 0);
  await runtime.start('combined-entry');
  assert.equal(runtime.inspectTools('session-one').length, 1);
  assert.equal(runtime.inspectUi('session-one').length, 2);
  assert.equal(runtime.inspectEventListeners('session-one').length, 1);
  await runtime.close();
});

test('failed package revision replacement leaves the current Fiber visible', async () => {
  const runtime = new HostExtensionRuntime();
  await runtime.installTrustedToolRevision({
    extensionId: 'fixture.atomic',
    revision: 'r1',
    tools: [
      {
        name: 'fixture_atomic',
        description: 'current',
        parameters: z.object({}),
        impl: async () => 'current',
      },
    ],
  });
  await runtime.installTrustedToolRevision({
    extensionId: 'fixture.atomic',
    revision: 'r2',
    tools: [],
    healthCheck: () => {
      throw new Error('candidate rejected');
    },
  });
  await runtime.activate({
    bindingId: 'atomic-entry',
    scopeId: 'profile',
    extensionId: 'fixture.atomic',
    revision: 'r1',
  });
  await assert.rejects(() => runtime.update('atomic-entry', 'r2'), /candidate rejected/u);
  assert.equal(runtime.inspect('atomic-entry').current?.revision, 'r1');
  assert.equal(runtime.inspectTools('profile')[0]?.revision, 'r1');
  await runtime.close();
});

function invocationContext() {
  return {
    sessionId: 'session-one',
    turnId: 'turn-one',
    cwd: process.cwd(),
    permissionMode: 'full_access',
    origin: 'host' as const,
    configuration: Object.freeze({}),
    signal: new AbortController().signal,
  };
}
