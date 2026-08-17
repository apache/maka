import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { MakaToolContext } from '@maka/runtime/tool-runtime';
import { HostExtensionController } from '../server/extension-controller.js';
import {
  InstalledToolPackageExtensionLoader,
  StaticTrustedToolExtensionLoader,
} from '../server/extension-loader.js';
import { HostExtensionRuntime } from '../server/extension-runtime.js';
import { HostExtensionStateStore } from '../server/extension-state-store.js';
import { EventPackageStore } from '../server/event-package-store.js';
import { HostEventPackageManagementTools } from '../server/event-package-management-tools.js';
import { HookPackageStore } from '../server/hook-package-store.js';
import type { ConnectionContext } from '../server/operation-dispatcher.js';
import { ToolPackageStore } from '../server/tool-package-store.js';
import { UiPackageStore } from '../server/ui-package-store.js';

const connection: ConnectionContext = {
  hostEpoch: 'event-package-system-test',
  connectionId: 'local-owner',
  surface: 'desktop',
  principal: 'local_os_user',
  acquireResidency: () => ({ release: () => undefined }),
};

test('cross-plugin Event contracts dispatch isolated Listeners and recover bindings', {
  timeout: 60_000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-event-package-'));
  const control = join(root, 'control');
  const providerSource = join(root, 'provider');
  const consumerSource = join(root, 'consumer');
  let fixture = createFixture(control);
  try {
    await writeProvider(providerSource);
    await writeConsumer(consumerSource);
    const provider = await fixture.loader.installPackage(providerSource);
    const consumer = await fixture.loader.installPackage(consumerSource);
    assert.deepEqual(provider.eventContributionIds, [
      'event:dev.maka.notes.audit.logged',
      'event:dev.maka.notes.note.changed',
    ]);
    assert.deepEqual(consumer.eventContributionIds, [
      'listener:dev.maka.notes.audit.logged:audit-record',
      'listener:dev.maka.notes.note.changed:record-change',
      'listener:dev.maka.notes.note.changed:reject-zero',
    ]);
    await fixture.controller.recover();
    assert.equal(
      (
        await fixture.controller.handlers['extension.catalog.mutate'](
          {
            kind: 'enable',
            bindingId: 'provider-binding',
            scopeId: 'session-1',
            extensionId: provider.extensionId,
            revision: provider.revision,
          },
          connection,
        )
      ).ok,
      true,
    );
    assert.equal(
      (
        await fixture.controller.handlers['extension.catalog.mutate'](
          {
            kind: 'enable',
            bindingId: 'consumer-binding',
            scopeId: 'session-1',
            extensionId: consumer.extensionId,
            revision: consumer.revision,
          },
          connection,
        )
      ).ok,
      true,
    );
    assert.equal(fixture.runtime.inspectEvents('session-1').length, 2);
    assert.equal(fixture.runtime.inspectEventListeners('session-1').length, 3);

    const result = await fixture.runtime.emitEvent(
      'session-1',
      'dev.maka.notes.note.changed',
      { id: 'note-1', value: 2 },
      invocationContext(root),
    );
    assert.deepEqual(result, {
      event: 'dev.maka.notes.note.changed',
      listenerCount: 2,
      delivered: 1,
      failed: 1,
      failures: [
        {
          extensionId: 'dev.maka.notes.consumer',
          listenerId: 'reject-zero',
          diagnostic: 'contained listener failure',
        },
      ],
    });
    await assert.rejects(
      fixture.runtime.emitEvent(
        'session-1',
        'dev.maka.notes.note.changed',
        { id: 'note-1' },
        invocationContext(root),
      ),
      /payload does not match/u,
    );

    await fixture.runtime.close();
    fixture = createFixture(control);
    await fixture.controller.recover();
    assert.equal(fixture.runtime.inspectEvents('session-1').length, 2);
    assert.equal(fixture.runtime.inspectEventListeners('session-1').length, 3);
    assert.equal(
      (
        await fixture.runtime.emitEvent(
          'session-1',
          'dev.maka.notes.note.changed',
          { id: 'note-2', value: 3 },
          invocationContext(root),
        )
      ).listenerCount,
      2,
    );
    await fixture.controller.handlers['extension.catalog.mutate'](
      { kind: 'remove', bindingId: 'consumer-binding' },
      connection,
    );
    assert.equal(fixture.runtime.inspectEventListeners('session-1').length, 0);
  } finally {
    await fixture.runtime.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test('Agent Event tools define, test, activate, emit, inspect, and stop a package', {
  timeout: 60_000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-event-management-'));
  const control = join(root, 'control');
  const fixture = createFixture(control);
  try {
    await fixture.controller.recover();
    const management = new HostEventPackageManagementTools(
      control,
      fixture.controller,
      fixture.runtime,
      fixture.eventStore,
    );
    const tools = management.tools();
    assert.deepEqual(
      tools.map(({ name }) => name),
      ['inspect_events', 'define_event', 'test_listener', 'emit_event', 'manage_event'],
    );
    const context = toolContext(root);
    const defined = (await tools
      .find(({ name }) => name === 'define_event')!
      .impl(
        {
          id: 'dev.maka.dynamic.events',
          version: '1.0.0',
          source:
            "export default { observe: async (payload) => { if (payload.value !== 7) throw new Error('wrong payload'); } };\n",
          events: [
            {
              name: 'dev.maka.dynamic.events.changed',
              description: 'A typed change.',
              payloadSchema: {
                type: 'object',
                properties: { value: { type: 'number' } },
                required: ['value'],
                additionalProperties: false,
              },
            },
          ],
          listeners: [
            {
              id: 'observe',
              event: 'dev.maka.dynamic.events.changed',
              handler: 'observe',
              priority: 10,
              timeoutMs: 1_000,
            },
          ],
          permissions: { workspace: 'none', network: false },
        } as never,
        context,
      )) as { revision: string };
    assert.match(defined.revision, /^sha256-[a-f0-9]{64}$/u);
    assert.deepEqual(
      await tools
        .find(({ name }) => name === 'test_listener')!
        .impl(
          {
            extensionId: 'dev.maka.dynamic.events',
            revision: defined.revision,
            listenerId: 'observe',
            event: 'dev.maka.dynamic.events.changed',
            payload: { value: 7 },
          } as never,
          context,
        ),
      { delivered: true },
    );
    await tools
      .find(({ name }) => name === 'manage_event')!
      .impl(
        {
          action: 'activate',
          extensionId: 'dev.maka.dynamic.events',
          revision: defined.revision,
        } as never,
        context,
      );
    assert.deepEqual(
      await tools
        .find(({ name }) => name === 'emit_event')!
        .impl(
          { event: 'dev.maka.dynamic.events.changed', payload: { value: 7 } } as never,
          context,
        ),
      {
        event: 'dev.maka.dynamic.events.changed',
        listenerCount: 1,
        delivered: 1,
        failed: 0,
        failures: [],
      },
    );
    const inspected = (await tools
      .find(({ name }) => name === 'inspect_events')!
      .impl({} as never, context)) as { events: unknown[]; listeners: unknown[] };
    assert.equal(inspected.events.length, 1);
    assert.equal(inspected.listeners.length, 1);
    await tools
      .find(({ name }) => name === 'manage_event')!
      .impl({ action: 'stop', extensionId: 'dev.maka.dynamic.events' } as never, context);
    assert.equal(fixture.runtime.inspectEvents('session-1').length, 0);
  } finally {
    await fixture.runtime.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

function createFixture(control: string) {
  const runtime = new HostExtensionRuntime();
  const eventStore = new EventPackageStore(control);
  const loader = new InstalledToolPackageExtensionLoader(
    new StaticTrustedToolExtensionLoader(),
    new ToolPackageStore(control),
    new UiPackageStore(control),
    new HookPackageStore(control),
    eventStore,
  );
  const controller = new HostExtensionController(
    runtime,
    loader,
    new HostExtensionStateStore(control),
    () => undefined,
  );
  return { runtime, loader, controller, eventStore };
}

async function writeProvider(root: string): Promise<void> {
  await mkdir(join(root, 'dist'), { recursive: true });
  await writeFile(
    join(root, 'maka.extension.json'),
    JSON.stringify({ schemaVersion: 1, id: 'dev.maka.notes', version: '1.0.0' }),
  );
  await writeFile(
    join(root, 'maka.event.json'),
    JSON.stringify({
      schemaVersion: 1,
      id: 'dev.maka.notes',
      version: '1.0.0',
      entry: 'dist/events.mjs',
      events: [
        {
          name: 'dev.maka.notes.audit.logged',
          description: 'An audit marker was emitted.',
          payloadSchema: {
            type: 'object',
            properties: { id: { type: 'string' } },
            required: ['id'],
            additionalProperties: false,
          },
        },
        {
          name: 'dev.maka.notes.note.changed',
          description: 'A note changed.',
          payloadSchema: {
            type: 'object',
            properties: { id: { type: 'string' }, value: { type: 'number' } },
            required: ['id', 'value'],
            additionalProperties: false,
          },
        },
      ],
      listeners: [],
      permissions: { workspace: 'none', network: false },
    }),
  );
  await writeFile(join(root, 'dist', 'events.mjs'), 'export default {};\n');
}

async function writeConsumer(root: string): Promise<void> {
  await mkdir(join(root, 'dist'), { recursive: true });
  await writeFile(
    join(root, 'maka.extension.json'),
    JSON.stringify({
      schemaVersion: 1,
      id: 'dev.maka.notes.consumer',
      version: '1.0.0',
      dependencies: [{ id: 'dev.maka.notes', version: '^1.0.0' }],
    }),
  );
  await writeFile(
    join(root, 'maka.event.json'),
    JSON.stringify({
      schemaVersion: 1,
      id: 'dev.maka.notes.consumer',
      version: '1.0.0',
      entry: 'dist/listeners.mjs',
      events: [],
      listeners: [
        {
          id: 'audit-record',
          event: 'dev.maka.notes.audit.logged',
          handler: 'auditRecord',
          priority: 100,
        },
        {
          id: 'record-change',
          event: 'dev.maka.notes.note.changed',
          handler: 'recordChange',
          priority: 100,
        },
        {
          id: 'reject-zero',
          event: 'dev.maka.notes.note.changed',
          handler: 'rejectZero',
          priority: 0,
        },
      ],
      permissions: { workspace: 'none', network: false },
    }),
  );
  await writeFile(
    join(root, 'dist', 'listeners.mjs'),
    `export default {
      recordChange: async (payload, context) => {
        if (payload.id !== 'note-1' && payload.id !== 'note-2') throw new Error('unexpected note');
        const nested = await context.emitEvent('dev.maka.notes.audit.logged', { id: payload.id });
        if (nested.delivered !== 1 || nested.failed !== 0) throw new Error('nested Event failed');
      },
      auditRecord: async (payload) => {
        if (!payload.id.startsWith('note-')) throw new Error('unexpected audit');
      },
      rejectZero: async () => { throw new Error('contained listener failure'); }
    };\n`,
  );
}

function invocationContext(cwd: string) {
  return {
    sessionId: 'session-1',
    runId: 'run-1',
    turnId: 'turn-1',
    cwd,
    permissionMode: 'ask',
    origin: 'host' as const,
    configuration: Object.freeze({}),
    signal: new AbortController().signal,
  };
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
