import assert from 'node:assert/strict';
import test from 'node:test';
import type { RuntimeHostConnection } from '@maka/runtime-host/client';
import type {
  OperationInput,
  OperationKey,
  SessionCatalogProjection,
} from '@maka/runtime-host/protocol';
import {
  DesktopRuntimeHostClient,
  DesktopRuntimeHostClientError,
} from '../runtime-host-client.js';

test('restarts a paginated catalog read instead of mixing revisions', async () => {
  const revisionOne = catalogRevision('1');
  const revisionTwo = catalogRevision('2');
  const { client, requests } = clientWithResponses([
    {
      kind: 'page',
      revision: revisionOne,
      sessions: [session('stale', 1)],
      nextCursor: 'stale-cursor',
    },
    {
      kind: 'revision_changed',
      expectedRevision: revisionOne,
      actualRevision: revisionTwo,
    },
    {
      kind: 'page',
      revision: revisionTwo,
      sessions: [session('fresh-1', 2)],
      nextCursor: 'fresh-cursor',
    },
    {
      kind: 'page',
      revision: revisionTwo,
      sessions: [session('fresh-2', 1)],
      nextCursor: null,
    },
  ]);

  assert.deepEqual(
    (await client.listSessions({ isArchived: false })).map(({ id }) => id),
    ['fresh-1', 'fresh-2'],
  );
  assert.deepEqual(requests, [
    {
      operation: 'session.catalog.query',
      input: { kind: 'list_start', filter: { isArchived: false } },
    },
    {
      operation: 'session.catalog.query',
      input: {
        kind: 'list_continue',
        filter: { isArchived: false },
        revision: revisionOne,
        cursor: 'stale-cursor',
      },
    },
    {
      operation: 'session.catalog.query',
      input: { kind: 'list_start', filter: { isArchived: false } },
    },
    {
      operation: 'session.catalog.query',
      input: {
        kind: 'list_continue',
        filter: { isArchived: false },
        revision: revisionTwo,
        cursor: 'fresh-cursor',
      },
    },
  ]);
});

test('re-reads the Session revision before retrying a product update', async () => {
  const { client, requests } = clientWithResponses([
    { kind: 'session', session: session('session-1', 4) },
    { kind: 'revision_conflict', expectedRevision: 4, actualRevision: 5 },
    { kind: 'session', session: session('session-1', 5) },
    { kind: 'committed', session: session('session-1', 6, { name: 'Renamed' }) },
  ]);

  const updated = await client.updateSessionMetadata('session-1', { name: 'Renamed' });

  assert.equal(updated.revision, 6);
  assert.equal(updated.name, 'Renamed');
  assert.deepEqual(requests, [
    {
      operation: 'session.catalog.query',
      input: { kind: 'get', sessionId: 'session-1' },
    },
    {
      operation: 'session.metadata.update',
      input: {
        sessionId: 'session-1',
        expectedRevision: 4,
        patch: { name: 'Renamed' },
      },
    },
    {
      operation: 'session.catalog.query',
      input: { kind: 'get', sessionId: 'session-1' },
    },
    {
      operation: 'session.metadata.update',
      input: {
        sessionId: 'session-1',
        expectedRevision: 5,
        patch: { name: 'Renamed' },
      },
    },
  ]);
});

test('merges a configuration patch into each fresh CAS projection', async () => {
  const { client, requests } = clientWithResponses([
    { kind: 'session', session: session('session-1', 10) },
    { kind: 'revision_conflict', expectedRevision: 10, actualRevision: 11 },
    {
      kind: 'session',
      session: session('session-1', 11, { collaborationMode: 'plan' }),
    },
    {
      kind: 'committed',
      session: session('session-1', 12, {
        collaborationMode: 'plan',
        permissionMode: 'execute',
      }),
    },
  ]);

  const updated = await client.updateSessionConfiguration('session-1', {
    permissionMode: 'execute',
  });

  assert.equal(updated.permissionMode, 'execute');
  assert.equal(updated.collaborationMode, 'plan');
  assert.deepEqual(
    requests
      .filter(({ operation }) => operation === 'session.configuration.update')
      .map(({ input }) => input),
    [
      {
        sessionId: 'session-1',
        expectedRevision: 10,
        configuration: {
          modelTarget: {
            kind: 'explicit',
            connectionSlug: 'test-connection',
            model: 'test-model',
          },
          thinkingLevel: null,
          permissionMode: 'execute',
          collaborationMode: 'agent',
          orchestrationMode: 'default',
        },
      },
      {
        sessionId: 'session-1',
        expectedRevision: 11,
        configuration: {
          modelTarget: {
            kind: 'explicit',
            connectionSlug: 'test-connection',
            model: 'test-model',
          },
          thinkingLevel: null,
          permissionMode: 'execute',
          collaborationMode: 'plan',
          orchestrationMode: 'default',
        },
      },
    ],
  );
});

test('treats empty configuration patches as read-only lookups', async () => {
  const unlocked = session('session-1', 10, { connectionLocked: false });
  const { client, requests } = clientWithResponses([
    { kind: 'session', session: unlocked },
    { kind: 'session', session: unlocked },
  ]);

  assert.deepEqual(await client.updateSessionConfiguration('session-1', {}), unlocked);
  assert.deepEqual(
    await client.updateSessionConfiguration('session-1', { thinkingLevel: undefined }),
    unlocked,
  );
  assert.deepEqual(requests, [
    {
      operation: 'session.catalog.query',
      input: { kind: 'get', sessionId: 'session-1' },
    },
    {
      operation: 'session.catalog.query',
      input: { kind: 'get', sessionId: 'session-1' },
    },
  ]);
});

test('binds message controls to the current Host Epoch', async () => {
  const { client, requests } = clientWithResponses([
    { disposition: 'steering', queueRevision: 2 },
    { queueRevision: 3, retracted: [] },
    {
      queueRevision: 4,
      retracted: [],
      turn: {
        sessionId: 'session-1',
        turnId: 'turn-1',
        runId: 'run-1',
        status: 'cancelled',
        terminalEventId: 'event-1',
        abortSource: 'user',
      },
    },
  ]);

  await client.submitMessage({
    sessionId: 'session-1',
    messageId: 'message-1',
    content: { text: 'Steer it' },
    placement: 'current_turn',
  });
  await client.retractQueue({ sessionId: 'session-1', retractId: 'retract-1' });
  await client.interruptTurn({
    sessionId: 'session-1',
    interruptId: 'interrupt-1',
    turnId: 'turn-1',
    runId: 'run-1',
  });

  assert.deepEqual(requests, [
    {
      operation: 'turn.message.submit',
      input: {
        sessionId: 'session-1',
        messageId: 'message-1',
        content: { text: 'Steer it' },
        placement: 'current_turn',
        originHostEpoch: 'host-current',
      },
    },
    {
      operation: 'queue.retract',
      input: {
        sessionId: 'session-1',
        retractId: 'retract-1',
        originHostEpoch: 'host-current',
      },
    },
    {
      operation: 'turn.interrupt',
      input: {
        sessionId: 'session-1',
        interruptId: 'interrupt-1',
        turnId: 'turn-1',
        runId: 'run-1',
        originHostEpoch: 'host-current',
      },
    },
  ]);
});

test('fails explicitly when the Host cannot represent a legacy Session', async () => {
  const { client } = clientWithResponses([
    {
      kind: 'session',
      session: {
        kind: 'unsupported_legacy_record',
        id: 'legacy-session',
        revision: 1,
        reason: 'not_wire_representable',
      },
    },
  ]);

  await assert.rejects(
    () => client.getSession('legacy-session'),
    (error: unknown) =>
      error instanceof DesktopRuntimeHostClientError && error.code === 'unsupported_session',
  );
});

interface RecordedRequest {
  operation: OperationKey;
  input: unknown;
}

function clientWithResponses(responses: unknown[]): {
  client: DesktopRuntimeHostClient;
  requests: RecordedRequest[];
} {
  const requests: RecordedRequest[] = [];
  const connection = {
    hostEpoch: 'host-current',
    request: async <K extends OperationKey>(operation: K, input: OperationInput<K>) => {
      requests.push({ operation, input });
      if (responses.length === 0) throw new Error(`Unexpected operation: ${operation}`);
      return responses.shift();
    },
    close: async () => undefined,
  } as unknown as RuntimeHostConnection;
  return { client: new DesktopRuntimeHostClient(connection), requests };
}

function catalogRevision(seed: string): `sha256:${string}` {
  return `sha256:${seed.repeat(64)}`;
}

function session(
  id: string,
  revision: number,
  overrides: Partial<SessionCatalogProjection> = {},
): SessionCatalogProjection {
  return {
    id,
    revision,
    cwd: '/workspace',
    createdAt: 1,
    lastUsedAt: 1,
    name: id,
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
    ...overrides,
  };
}
