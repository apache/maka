import assert from 'node:assert/strict';
import { setImmediate as delayImmediate } from 'node:timers/promises';
import test from 'node:test';
import type { SessionEvent, SessionHeader } from '@maka/core';
import { TOOL_OUTPUT_DELTA_MAX_CHARS } from '@maka/core/events';
import { PermissionEngine, PiAgentBackend, type PiAgentTransport } from '@maka/runtime';
import {
  decodeHostFrame,
  encodeProtocolFrame,
  ProtocolFrameDecoder,
  RUNTIME_HOST_MAX_FRAME_BYTES,
  type SubscriptionFrame,
} from '../protocol/index.js';
import type { ConnectionContext } from '../server/operation-dispatcher.js';
import {
  type CanonicalSessionProjection,
  SessionContinuityCoordinator,
} from '../server/session-continuity-coordinator.js';
import { SessionAdmissionGate } from '../server/session-admission-gate.js';
import type { SessionContinuityFrameSink } from '../server/session-continuity-service.js';

const HOST_EPOCH = 'host-epoch';
const SESSION_ID = 'session-1';

test('open is an inactive publication barrier and live sequence starts at nextSequence', async () => {
  const read = deferred<CanonicalSessionProjection | null>();
  const coordinator = new SessionContinuityCoordinator(
    HOST_EPOCH,
    () => read.promise,
    new SessionAdmissionGate(),
  );
  const sink = new RecordingSink();
  const connection = coordinator.attachConnection('connection-1', sink);

  const opening = coordinator.handlers['subscription.open'](
    { sessionId: SESSION_ID },
    connectionContext('connection-1'),
  );
  await delayImmediate();
  const publishing = coordinator.acceptRuntimeEvent(SESSION_ID, 'run-1', textEvent(1));
  read.resolve(canonical());

  const outcome = await opening;
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  await publishing;
  assert.equal(outcome.result.nextSequence, 1);
  assert.equal(Object.isFrozen(outcome.result.snapshot), true);
  assert.equal(sink.frames.length, 0);

  connection.activate(outcome.result.subscriptionId);
  await delayImmediate();
  assert.deepEqual(
    sink.frames.map((frame) => frame.sequence),
    [1],
  );
  assert.equal(sink.frames[0]?.kind, 'subscription.session_delta');

  connection.abort(outcome.result.subscriptionId);
  await coordinator.acceptRuntimeEvent(SESSION_ID, 'run-1', textEvent(2));
  assert.equal(sink.frames.length, 1);
  coordinator.close();
});

test('terminal fence suppresses ordinary refresh until the exact terminal cut publishes', async () => {
  let projection = canonical({
    rootTurn: { sessionId: SESSION_ID, turnId: 'turn-1', runId: 'run-1', status: 'running' },
  });
  const coordinator = new SessionContinuityCoordinator(
    HOST_EPOCH,
    async () => projection,
    new SessionAdmissionGate(),
  );
  const sink = new RecordingSink();
  const connection = coordinator.attachConnection('connection-1', sink);
  const opened = await open(coordinator, 'connection-1');
  connection.activate(opened.subscriptionId);

  await coordinator.holdTerminalPublication(SESSION_ID, 'turn-1', 'run-1');
  projection = canonical({
    rootTurn: {
      sessionId: SESSION_ID,
      turnId: 'turn-1',
      runId: 'run-1',
      status: 'completed',
      terminalEventId: 'event-terminal',
    },
  });
  await coordinator.refreshCanonical(SESSION_ID);
  assert.equal(sink.frames.length, 0);

  await coordinator.publishTerminalProjection(SESSION_ID, 'turn-1', 'run-1');
  await delayImmediate();
  assert.equal(sink.frames.length, 1);
  const frame = sink.frames[0];
  assert.equal(frame?.kind, 'subscription.session_projection');
  if (frame?.kind === 'subscription.session_projection') {
    assert.equal(frame.sequence, 1);
    assert.equal(frame.snapshot.projectionRevision, 2);
    assert.equal(frame.snapshot.rootTurn?.status, 'completed');
  }
  coordinator.close();
});

test('detached canonical refreshes coalesce before Store I/O', async () => {
  let projection = canonical();
  let reads = 0;
  const refreshRead = deferred<void>();
  const refreshEntered = deferred<void>();
  const coordinator = new SessionContinuityCoordinator(
    HOST_EPOCH,
    async () => {
      reads += 1;
      if (reads === 2) {
        refreshEntered.resolve();
        await refreshRead.promise;
      }
      return projection;
    },
    new SessionAdmissionGate(),
  );
  const sink = new RecordingSink();
  const connection = coordinator.attachConnection('connection-1', sink);
  const opened = await open(coordinator, 'connection-1');
  connection.activate(opened.subscriptionId);

  projection = canonical({ lastUsedAt: 2 });
  coordinator.enqueueCanonicalRefresh(SESSION_ID);
  coordinator.enqueueCanonicalRefresh(SESSION_ID);
  await refreshEntered.promise;
  assert.equal(reads, 2);
  refreshRead.resolve();
  await waitFor(() => sink.frames.length === 1);
  assert.equal(reads, 2);
  coordinator.close();
});

test('in-flight canonical refresh observes an invalidation after its first read', async () => {
  let projection = canonical();
  let reads = 0;
  const firstRefreshRead = deferred<CanonicalSessionProjection | null>();
  const coordinator = new SessionContinuityCoordinator(
    HOST_EPOCH,
    async () => {
      reads += 1;
      if (reads === 2) return firstRefreshRead.promise;
      return projection;
    },
    new SessionAdmissionGate(),
  );
  const sink = new RecordingSink();
  const connection = coordinator.attachConnection('connection-1', sink);
  const opened = await open(coordinator, 'connection-1');
  connection.activate(opened.subscriptionId);

  const stale = canonical({ lastUsedAt: 2 });
  coordinator.enqueueCanonicalRefresh(SESSION_ID);
  await waitFor(() => reads === 2);
  firstRefreshRead.resolve(stale);
  projection = canonical({ lastUsedAt: 3 });
  coordinator.enqueueCanonicalRefresh(SESSION_ID);

  await waitFor(() => reads === 3 && sink.frames.length === 2);
  assert.deepEqual(
    sink.frames.map((frame) =>
      frame.kind === 'subscription.session_projection'
        ? frame.snapshot.session.lastUsedAt
        : undefined,
    ),
    [2, 3],
  );
  coordinator.close();
});

test('tool output preserves one domain event and one wire frame', async () => {
  const coordinator = new SessionContinuityCoordinator(
    HOST_EPOCH,
    async () => canonical(),
    new SessionAdmissionGate(),
  );
  const sink = new RecordingSink();
  const connection = coordinator.attachConnection('connection-1', sink);
  const opened = await open(coordinator, 'connection-1');
  connection.activate(opened.subscriptionId);
  let nextId = 0;
  let now = 1;
  const source = '界'.repeat(TOOL_OUTPUT_DELTA_MAX_CHARS + 1);
  const transport = {
    async *send() {
      yield {
        type: 'tool_output_delta' as const,
        toolUseId: 'tool-1',
        stream: 'stdout' as const,
        chunk: source,
      };
      yield { type: 'complete' as const };
    },
  } satisfies PiAgentTransport;
  const backend = new PiAgentBackend({
    sessionId: SESSION_ID,
    header: piSessionHeader(),
    appendMessage: async () => undefined,
    permissionEngine: new PermissionEngine({
      newId: () => `permission-${++nextId}`,
      now: () => now++,
    }),
    transport,
    newId: () => `event-${++nextId}`,
    now: () => now++,
  });
  const produced: SessionEvent[] = [];
  for await (const event of backend.send({ turnId: 'turn-1', text: 'inspect', context: [] })) {
    produced.push(event);
  }
  const outputs = produced.filter(
    (event): event is Extract<SessionEvent, { type: 'tool_output_delta' }> =>
      event.type === 'tool_output_delta',
  );
  assert.equal(outputs.length, 1);
  const output = outputs[0];
  assert.ok(output);
  assert.ok(output.chunk.length <= TOOL_OUTPUT_DELTA_MAX_CHARS);
  assert.match(output.chunk, /\n\[内容已截断\]$/);

  await coordinator.acceptRuntimeEvent(SESSION_ID, 'run-1', output);
  await waitFor(() => sink.frames.length === 1);

  const encoded = encodeProtocolFrame(sink.frames[0]!);
  assert.ok(encoded.byteLength <= RUNTIME_HOST_MAX_FRAME_BYTES);
  const decodedFrames = new ProtocolFrameDecoder().push(encoded);
  assert.equal(decodedFrames.length, 1);
  const decoded = decodeHostFrame(decodedFrames[0]);
  assert.ok('kind' in decoded);
  if (!('kind' in decoded)) return;
  assert.equal(decoded.kind, 'subscription.session_event');
  if (decoded.kind !== 'subscription.session_event') return;
  assert.equal(decoded.event.type, 'tool_output_delta');
  if (decoded.event.type !== 'tool_output_delta') return;
  assert.equal(decoded.event.id, output.id);
  assert.equal(decoded.event.seq, output.seq);
  assert.equal(decoded.event.chunk, output.chunk);
  coordinator.close();
});

test('reports a detached canonical publication failure to the Host lifecycle', async () => {
  let reads = 0;
  const observed = deferred<unknown>();
  const coordinator = new SessionContinuityCoordinator(
    HOST_EPOCH,
    async () => {
      reads += 1;
      if (reads === 1) return canonical();
      throw new Error('canonical Store read failed');
    },
    new SessionAdmissionGate(),
    (error) => observed.resolve(error),
  );
  const connection = coordinator.attachConnection('connection-1', new RecordingSink());
  const opened = await open(coordinator, 'connection-1');
  connection.activate(opened.subscriptionId);

  coordinator.enqueueCanonicalRefresh(SESSION_ID);
  const failure = await observed.promise;
  assert.match(String(failure), /canonical Store read failed/);
  coordinator.close();
});

test('rejects a live event that is not owned by the canonical root', async () => {
  const coordinator = new SessionContinuityCoordinator(
    HOST_EPOCH,
    async () => canonical(),
    new SessionAdmissionGate(),
  );
  const connection = coordinator.attachConnection('connection-1', new RecordingSink());
  const opened = await open(coordinator, 'connection-1');
  connection.activate(opened.subscriptionId);

  await assert.rejects(
    coordinator.acceptRuntimeEvent(SESSION_ID, 'different-run', textEvent(1)),
    /canonical active root Turn/,
  );
  coordinator.close();
});

test('slow subscriber receives a terminal eviction without delaying another subscriber', async () => {
  const coordinator = new SessionContinuityCoordinator(
    HOST_EPOCH,
    async () => canonical(),
    new SessionAdmissionGate(),
  );
  const slowSink = new RecordingSink();
  const fastSink = new RecordingSink();
  const slowConnection = coordinator.attachConnection('connection-slow', slowSink);
  const fastConnection = coordinator.attachConnection('connection-fast', fastSink);
  const slow = await open(coordinator, 'connection-slow');
  const fast = await open(coordinator, 'connection-fast');
  fastConnection.activate(fast.subscriptionId);

  for (let index = 1; index <= 32; index += 1) {
    await coordinator.acceptRuntimeEvent(SESSION_ID, 'run-1', textEvent(index));
  }
  slowConnection.activate(slow.subscriptionId);
  await waitFor(() => slowSink.frames.length === 1 && fastSink.frames.length === 32);

  assert.deepEqual(slowSink.frames[0], {
    kind: 'subscription.closed',
    hostEpoch: HOST_EPOCH,
    subscriptionId: slow.subscriptionId,
    sequence: 1,
    reason: 'slow_consumer',
  });
  assert.deepEqual(
    fastSink.frames.map((frame) => frame.sequence),
    Array.from({ length: 32 }, (_, index) => index + 1),
  );
  coordinator.close();
});

class RecordingSink implements SessionContinuityFrameSink {
  readonly frames: SubscriptionFrame[] = [];

  async send(frame: SubscriptionFrame): Promise<void> {
    this.frames.push(frame);
  }
}

async function open(coordinator: SessionContinuityCoordinator, connectionId: string) {
  const outcome = await coordinator.handlers['subscription.open'](
    { sessionId: SESSION_ID },
    connectionContext(connectionId),
  );
  if (!outcome.ok) throw new Error(outcome.error.message);
  assert.equal(outcome.ok, true);
  return outcome.result;
}

function connectionContext(connectionId: string): ConnectionContext {
  return {
    hostEpoch: HOST_EPOCH,
    connectionId,
    surface: 'tui',
    principal: 'local_os_user',
    acquireResidency: () => ({ release() {} }),
  };
}

function canonical(
  overrides: { lastUsedAt?: number; rootTurn?: CanonicalSessionProjection['rootTurn'] } = {},
): CanonicalSessionProjection {
  return {
    session: {
      sessionId: SESSION_ID,
      status: 'active',
      createdAt: 1,
      lastUsedAt: overrides.lastUsedAt ?? 1,
      isArchived: false,
    },
    rootTurn:
      overrides.rootTurn === undefined
        ? { sessionId: SESSION_ID, turnId: 'turn-1', runId: 'run-1', status: 'running' }
        : overrides.rootTurn,
    queue: {
      hostEpoch: HOST_EPOCH,
      queueRevision: 0,
      steering: [],
      followup: [],
    },
  };
}

function piSessionHeader(): SessionHeader {
  return {
    id: SESSION_ID,
    workspaceRoot: '/tmp/maka',
    cwd: '/tmp/maka',
    createdAt: 1,
    lastUsedAt: 1,
    name: 'Pi continuity test',
    titleIsManual: true,
    isFlagged: false,
    labels: [],
    isArchived: false,
    status: 'active',
    hasUnread: false,
    backend: 'pi-agent',
    llmConnectionSlug: 'pi-agent',
    connectionLocked: true,
    model: 'pi-test',
    permissionMode: 'execute',
    schemaVersion: 1,
  };
}

function textEvent(index: number) {
  return {
    type: 'text_delta' as const,
    id: `event-${index}`,
    turnId: 'turn-1',
    ts: index,
    messageId: 'message-1',
    text: `chunk-${index}`,
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await delayImmediate();
  }
  throw new Error('Timed out waiting for continuity state');
}
