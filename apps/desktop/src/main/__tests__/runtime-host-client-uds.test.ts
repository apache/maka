import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { connectRuntimeHost } from '@maka/runtime-host/client';
import {
  HOST_OPERATION_SPECS,
  RUNTIME_HOST_PROTOCOL_VERSION,
  type OperationKey,
} from '@maka/runtime-host/protocol';
import {
  RuntimeHostKernel,
  type RuntimeHostComposition,
} from '@maka/runtime-host/server';
import {
  resolveStorageRoot,
  tryAcquireInteractiveRootOwner,
} from '@maka/storage/root-authority';
import { DesktopRuntimeHostClient } from '../runtime-host-client.js';

test('drives Desktop Session operations through a real Runtime Host connection', async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-desktop-host-client-'));
  let host: RuntimeHostKernel | undefined;
  try {
    const capability = await resolveStorageRoot({ path: base, kind: 'interactive' });
    const owner = await tryAcquireInteractiveRootOwner(capability);
    assert.ok(owner);
    const projected = session('session-1');
    host = await RuntimeHostKernel.start({
      owner,
      idleGraceMs: 10_000,
      compositionFactory: async ({ hostEpoch }) => ({
        handlers: handlers({
          'session.catalog.query': async (input) =>
            input.kind === 'get'
              ? { ok: true, result: { kind: 'session', session: projected } }
              : {
                  ok: true,
                  result: {
                    kind: 'page',
                    revision: catalogRevision('1'),
                    sessions: [projected],
                    nextCursor: null,
                  },
                },
          'turn.message.submit': async (input) => {
            assert.equal(input.originHostEpoch, hostEpoch);
            return { ok: true, result: { disposition: 'steering', queueRevision: 1 } };
          },
        }),
        beginDrain() {},
        async recover() {},
        async close() {},
      }),
    });
    const connected = await connectRuntimeHost({
      rootPath: base,
      surface: 'desktop',
      protocol: {
        min: RUNTIME_HOST_PROTOCOL_VERSION,
        max: RUNTIME_HOST_PROTOCOL_VERSION,
      },
    });
    assert.equal(connected.kind, 'connected');
    if (connected.kind !== 'connected') throw new Error('Desktop did not connect to Runtime Host');
    const client = new DesktopRuntimeHostClient(connected.connection);

    assert.deepEqual(await client.listSessions(), [projected]);
    assert.deepEqual(
      await client.updateSessionConfiguration(projected.id, { thinkingLevel: undefined }),
      projected,
    );
    assert.deepEqual(
      await client.submitMessage({
        sessionId: projected.id,
        messageId: 'message-1',
        content: { text: 'Continue with the new constraints.' },
        placement: 'current_turn',
      }),
      { disposition: 'steering', queueRevision: 1 },
    );

    await client.close();
  } finally {
    await host?.close().catch(() => undefined);
    await rm(base, { recursive: true, force: true });
  }
});

type TestHandlers = Partial<RuntimeHostComposition['handlers']>;

function handlers(overrides: TestHandlers): RuntimeHostComposition['handlers'] {
  const unavailable = Object.fromEntries(
    (Object.keys(HOST_OPERATION_SPECS) as OperationKey[])
      .filter((operation) => operation !== 'host.status')
      .map((operation) => [
        operation,
        async () => ({
          ok: false,
          error: {
            code: 'operation_unavailable',
            message: `${operation} is unavailable in the Desktop adapter fixture`,
          },
        }),
      ]),
  );
  return { ...unavailable, ...overrides } as RuntimeHostComposition['handlers'];
}

function catalogRevision(seed: string): `sha256:${string}` {
  return `sha256:${seed.repeat(64)}`;
}

function session(id: string) {
  return {
    id,
    revision: 1,
    cwd: '/workspace',
    createdAt: 1,
    lastUsedAt: 1,
    name: 'Desktop Host Session',
    isFlagged: false,
    isArchived: false,
    labels: [],
    labelsTruncated: false,
    hasUnread: false,
    status: 'active',
    backend: 'ai-sdk',
    llmConnectionSlug: 'test-connection',
    connectionLocked: true,
    model: 'test-model',
    permissionMode: 'ask',
    collaborationMode: 'agent',
    orchestrationMode: 'default',
  } as const;
}
