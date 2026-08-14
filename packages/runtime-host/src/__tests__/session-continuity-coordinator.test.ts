import assert from 'node:assert/strict';
import { setImmediate as delayImmediate } from 'node:timers/promises';
import test from 'node:test';
import type { SessionEvent, ShellRunUpdate } from '@maka/core/events';
import type { StoredMessage } from '@maka/core/session';
import {
  decodeHostFrame,
  encodeProtocolMessage,
  RUNTIME_HOST_MAX_MESSAGE_BYTES,
  SESSION_TRANSCRIPT_BOOTSTRAP_MAX_BYTES,
  SESSION_TRANSCRIPT_PAGE_MAX_BYTES,
  type SubscriptionFrame,
} from '../protocol/index.js';
import type { ConnectionContext } from '../server/operation-dispatcher.js';
import {
  type CanonicalSessionProjection,
  SessionContinuityCoordinator,
} from '../server/session-continuity-coordinator.js';
import { SessionAdmissionGate } from '../server/session-admission-gate.js';
import type { SessionContinuityFrameSink } from '../server/session-continuity-service.js';
import type { SessionTranscriptReader } from '../server/session-transcript-reader.js';
import { ClientSessionSubscription } from '../client/session-subscription.js';
import { transcriptReader } from './fixtures/session-transcript-reader.js';

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
    { sessionId: SESSION_ID, transcript: { kind: 'none' } },
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

test('open snapshot includes pending Interactions from the canonical projection', async () => {
  const pending = pendingInteraction();
  const coordinator = new SessionContinuityCoordinator(
    HOST_EPOCH,
    async () => canonical({ interactions: { pending: [pending] } }),
    new SessionAdmissionGate(),
  );
  const connection = coordinator.attachConnection('connection-1', new RecordingSink());

  const opened = await open(coordinator, 'connection-1');
  assert.deepEqual(opened.snapshot.interactions, { pending: [pending] });

  connection.abort(opened.subscriptionId);
  coordinator.close();
});

test('open identifies every assistant stream that is still active and round-trips its result', async () => {
  const coordinator = new SessionContinuityCoordinator(
    HOST_EPOCH,
    async () => canonical(),
    new SessionAdmissionGate(),
  );
  coordinator.attachConnection('connection-1', new RecordingSink());
  await open(coordinator, 'connection-1');
  await coordinator.acceptRuntimeEvent(SESSION_ID, 'run-1', textEvent(1));
  await coordinator.acceptRuntimeEvent(
    SESSION_ID,
    'run-1',
    thinkingEvent('thinking_delta', 'message-2', 'reasoning'),
  );
  await coordinator.acceptRuntimeEvent(SESSION_ID, 'run-1', {
    ...textEvent(2),
    messageId: 'message-3',
  });

  coordinator.attachConnection('connection-2', new RecordingSink());
  const active = await open(coordinator, 'connection-2');
  assert.deepEqual(active.activeAssistantStreams, [
    { kind: 'text', turnId: 'turn-1', messageId: 'message-1' },
    { kind: 'thinking', turnId: 'turn-1', messageId: 'message-2' },
    { kind: 'text', turnId: 'turn-1', messageId: 'message-3' },
  ]);

  const decoded = decodeHostFrame(
    JSON.parse(
      encodeProtocolMessage({
        requestId: 'open-round-trip',
        operation: 'subscription.open',
        ok: true,
        result: active,
      }).toString('utf8'),
    ),
  );
  assert.ok('ok' in decoded && decoded.ok);
  if (!('ok' in decoded) || !decoded.ok || decoded.operation !== 'subscription.open') return;
  assert.deepEqual(decoded.result.activeAssistantStreams, active.activeAssistantStreams);

  await coordinator.acceptRuntimeEvent(
    SESSION_ID,
    'run-1',
    textCompleteEvent('message-1', 'chunk-1'),
  );
  coordinator.attachConnection('connection-3', new RecordingSink());
  const remaining = await open(coordinator, 'connection-3');
  assert.deepEqual(remaining.activeAssistantStreams, [
    { kind: 'thinking', turnId: 'turn-1', messageId: 'message-2' },
    { kind: 'text', turnId: 'turn-1', messageId: 'message-3' },
  ]);

  await coordinator.acceptRuntimeEvent(
    SESSION_ID,
    'run-1',
    thinkingEvent('thinking_complete', 'message-2', 'reasoning'),
  );
  await coordinator.acceptRuntimeEvent(SESSION_ID, 'run-1', textCompleteEvent('message-2', ''));
  await coordinator.acceptRuntimeEvent(
    SESSION_ID,
    'run-1',
    textCompleteEvent('message-3', 'chunk-2'),
  );
  coordinator.attachConnection('connection-4', new RecordingSink());
  const completed = await open(coordinator, 'connection-4');
  assert.deepEqual(completed.activeAssistantStreams, []);
  coordinator.close();
});

test('publishes a non-prefix final value as an authoritative replacement', async () => {
  const coordinator = new SessionContinuityCoordinator(
    HOST_EPOCH,
    async () => canonical(),
    new SessionAdmissionGate(),
  );
  const sink = new RecordingSink();
  const connection = coordinator.attachConnection('connection-1', sink);
  const opened = await open(coordinator, 'connection-1');
  connection.activate(opened.subscriptionId);

  await coordinator.acceptRuntimeEvent(SESSION_ID, 'run-1', {
    ...textEvent(1),
    text: 'draft',
  });
  await coordinator.acceptRuntimeEvent(
    SESSION_ID,
    'run-1',
    textCompleteEvent('message-1', 'final'),
  );
  await waitFor(() => sink.frames.length === 3);

  assert.deepEqual(
    sink.frames.map((frame) =>
      frame.kind === 'subscription.session_delta'
        ? {
            startOffset: frame.delta.startOffset,
            text: frame.delta.text,
            reset: frame.delta.reset === true,
            complete: frame.delta.complete === true,
          }
        : frame.kind,
    ),
    [
      { startOffset: 0, text: 'draft', reset: false, complete: false },
      { startOffset: 0, text: 'final', reset: true, complete: false },
      { startOffset: 5, text: '', reset: false, complete: true },
    ],
  );
  coordinator.close();
});

test('coalesces reasoning parts and completes the step before later steps continue', async () => {
  const coordinator = new SessionContinuityCoordinator(
    HOST_EPOCH,
    async () => canonical(),
    new SessionAdmissionGate(),
  );
  const sink = new RecordingSink();
  const connection = coordinator.attachConnection('connection-1', sink);
  const opened = await open(coordinator, 'connection-1');
  connection.activate(opened.subscriptionId);

  await coordinator.acceptRuntimeEvent(
    SESSION_ID,
    'run-1',
    thinkingEvent('thinking_delta', 'step-1', 'first'),
  );
  await coordinator.acceptRuntimeEvent(
    SESSION_ID,
    'run-1',
    thinkingEvent('thinking_delta', 'step-1', 'second'),
  );
  await coordinator.acceptRuntimeEvent(
    SESSION_ID,
    'run-1',
    thinkingEvent('thinking_complete', 'step-1', 'first'),
  );
  await coordinator.acceptRuntimeEvent(
    SESSION_ID,
    'run-1',
    thinkingEvent('thinking_complete', 'step-1', 'second'),
  );
  assert.equal(sink.frames.length, 2);
  await coordinator.acceptRuntimeEvent(SESSION_ID, 'run-1', textCompleteEvent('step-1', ''));
  await coordinator.acceptRuntimeEvent(
    SESSION_ID,
    'run-1',
    thinkingEvent('thinking_delta', 'step-2', 'second'),
  );
  await waitFor(() => sink.frames.length === 4);

  assert.deepEqual(
    sink.frames.map((frame) =>
      frame.kind === 'subscription.session_delta'
        ? {
            messageId: frame.delta.messageId,
            text: frame.delta.text,
            complete: frame.delta.complete === true,
          }
        : frame.kind,
    ),
    [
      { messageId: 'step-1', text: 'first', complete: false },
      { messageId: 'step-1', text: 'second', complete: false },
      { messageId: 'step-1', text: '', complete: true },
      { messageId: 'step-2', text: 'second', complete: false },
    ],
  );
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

test('does not reuse an active transcript overlay after terminal publication', async () => {
  let projection = canonical();
  const partial = assistantMessage('partial');
  const baseReader = transcriptReader([], [partial]);
  let overlayReads = 0;
  const reader: SessionTranscriptReader = {
    ...baseReader,
    readActiveOverlay: async (sessionId, rootTurn) => {
      overlayReads += 1;
      if (
        !rootTurn ||
        rootTurn.status === 'completed' ||
        rootTurn.status === 'failed' ||
        rootTurn.status === 'cancelled'
      ) {
        return [];
      }
      return baseReader.readActiveOverlay(sessionId, rootTurn);
    },
  };
  const coordinator = new SessionContinuityCoordinator(
    HOST_EPOCH,
    async () => projection,
    new SessionAdmissionGate(),
    undefined,
    reader,
  );
  await coordinator.holdTerminalPublication(SESSION_ID, 'turn-1', 'run-1');
  coordinator.attachConnection('connection-active-overlay', new RecordingSink());
  const active = await open(coordinator, 'connection-active-overlay', {
    kind: 'tail',
    maxBytes: SESSION_TRANSCRIPT_BOOTSTRAP_MAX_BYTES,
  });
  assert.ok((active.transcript?.overlay.rawBytes ?? 0) > 0);
  assert.equal(overlayReads, 1);

  projection = canonical({
    rootTurn: {
      sessionId: SESSION_ID,
      turnId: 'turn-1',
      runId: 'run-1',
      status: 'completed',
      terminalEventId: 'event-terminal',
    },
  });
  await coordinator.publishTerminalProjection(SESSION_ID, 'turn-1', 'run-1');

  coordinator.attachConnection('connection-terminal-overlay', new RecordingSink());
  const terminal = await open(coordinator, 'connection-terminal-overlay', {
    kind: 'tail',
    maxBytes: SESSION_TRANSCRIPT_BOOTSTRAP_MAX_BYTES,
  });
  assert.equal(terminal.snapshot.rootTurn?.status, 'completed');
  assert.equal(terminal.transcript?.overlay.rawBytes, 0);
  assert.equal(overlayReads, 1);
  const client = new ClientSessionSubscription(
    terminal,
    async () => undefined,
    async () => {
      throw new Error('empty terminal transcript unexpectedly requested another page');
    },
  );
  assert.deepEqual(await client.loadTranscript((value) => value), []);
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

test('coalesces Agent graph invalidations onto the Session subscription sequence', async () => {
  const coordinator = new SessionContinuityCoordinator(
    HOST_EPOCH,
    async () => canonical(),
    new SessionAdmissionGate(),
  );
  const sink = new RecordingSink();
  const connection = coordinator.attachConnection('connection-1', sink);
  const opened = await open(coordinator, 'connection-1');
  connection.activate(opened.subscriptionId);

  coordinator.enqueueAgentGraphChanged({
    rootSessionId: SESSION_ID,
    graphId: 'agent_graph_1',
    reason: 'observation',
  });
  coordinator.enqueueAgentGraphChanged({
    rootSessionId: SESSION_ID,
    graphId: 'agent_graph_1',
    reason: 'stopped',
  });
  await waitFor(() => sink.frames.length === 1);
  await coordinator.acceptRuntimeEvent(SESSION_ID, 'run-1', textEvent(1));
  await waitFor(() => sink.frames.length === 2);

  assert.deepEqual(sink.frames[0], {
    kind: 'subscription.agent_graph_changed',
    hostEpoch: HOST_EPOCH,
    subscriptionId: opened.subscriptionId,
    sequence: 1,
    rootSessionId: SESSION_ID,
    graphId: 'agent_graph_1',
    reason: 'stopped',
  });
  assert.equal(sink.frames[1]?.kind, 'subscription.session_delta');
  assert.equal(sink.frames[1]?.sequence, 2);
  coordinator.close();
});

test('coalesces typed domain invalidations without publishing continuity projections', async () => {
  const coordinator = new SessionContinuityCoordinator(
    HOST_EPOCH,
    async () => canonical(),
    new SessionAdmissionGate(),
  );
  const sink = new RecordingSink();
  const connection = coordinator.attachConnection('connection-1', sink);
  const opened = await open(coordinator, 'connection-1');
  connection.activate(opened.subscriptionId);

  coordinator.enqueueSessionDomainChanged(SESSION_ID, 'task');
  coordinator.enqueueSessionDomainChanged(SESSION_ID, 'task');
  coordinator.enqueueSessionDomainChanged(SESSION_ID, 'plan');
  await waitFor(() => sink.frames.length === 2);

  assert.deepEqual(
    sink.frames.map((frame) =>
      frame.kind === 'subscription.session_domain_changed'
        ? { kind: frame.kind, sequence: frame.sequence, domain: frame.domain }
        : frame.kind,
    ),
    [
      { kind: 'subscription.session_domain_changed', sequence: 1, domain: 'task' },
      { kind: 'subscription.session_domain_changed', sequence: 2, domain: 'plan' },
    ],
  );
  coordinator.close();
});

test('fans one bounded Runtime Resource burst out to an inherited Session view', async () => {
  const childSessionId = 'child-session';
  const coordinator = new SessionContinuityCoordinator(
    HOST_EPOCH,
    async (sessionId) => canonicalFor(sessionId),
    new SessionAdmissionGate(),
  );
  const sink = new RecordingSink();
  const connection = coordinator.attachConnection('connection-1', sink);
  const outcome = await coordinator.handlers['subscription.open'](
    { sessionId: childSessionId, transcript: { kind: 'none' } },
    connectionContext('connection-1'),
  );
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  connection.activate(outcome.result.subscriptionId);
  const updates = Array.from({ length: 64 }, (_, index) => {
    const update = shellRunUpdate({
      sessionId: 'parent-session',
      sourceToolCallId: `tool-${index}`,
    });
    update.result.ref = `shell:run-${index}`;
    return update;
  });

  for (const update of updates) coordinator.enqueueRuntimeResourceChanged(update);
  await waitFor(() => sink.frames.length === 1);

  assert.deepEqual(sink.frames[0], {
    kind: 'subscription.session_domain_changed',
    hostEpoch: HOST_EPOCH,
    subscriptionId: outcome.result.subscriptionId,
    sequence: 1,
    sessionId: childSessionId,
    domain: 'runtime_resource',
    resources: updates.map((update) => ({
      sourceSessionId: update.sessionId,
      ref: update.result.ref,
    })),
  });
  coordinator.close();
});

test('publishes live PTY bytes on the source Session continuity sequence', async () => {
  const coordinator = new SessionContinuityCoordinator(
    HOST_EPOCH,
    async () => canonical(),
    new SessionAdmissionGate(),
  );
  const sink = new RecordingSink();
  const connection = coordinator.attachConnection('connection-1', sink);
  const opened = await open(coordinator, 'connection-1');
  connection.activate(opened.subscriptionId);

  await coordinator.enqueueRuntimeResourcePtyData({
    sessionId: SESSION_ID,
    ref: 'maka://runtime/background-tasks/shell-1',
    sequence: 5,
    data: 'ready',
  });
  assert.deepEqual(sink.frames[0], {
    kind: 'subscription.runtime_resource_pty_data',
    hostEpoch: HOST_EPOCH,
    subscriptionId: opened.subscriptionId,
    sequence: 1,
    sessionId: SESSION_ID,
    ref: 'maka://runtime/background-tasks/shell-1',
    ptySequence: 5,
    data: 'ready',
  });
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

test('removal closes every Session subscriber at the admitted sequence boundary', async () => {
  const admission = new SessionAdmissionGate();
  const coordinator = new SessionContinuityCoordinator(
    HOST_EPOCH,
    async () => canonical(),
    admission,
  );
  const desktopSink = new RecordingSink();
  const tuiSink = new RecordingSink();
  const desktop = coordinator.attachConnection('connection-desktop', desktopSink);
  const tui = coordinator.attachConnection('connection-tui', tuiSink);
  const desktopSubscription = await open(coordinator, 'connection-desktop');
  const tuiSubscription = await open(coordinator, 'connection-tui');
  desktop.activate(desktopSubscription.subscriptionId);
  tui.activate(tuiSubscription.subscriptionId);

  await admission.run(SESSION_ID, (lease) => coordinator.retireSessions([SESSION_ID], lease));
  await waitFor(() => desktopSink.frames.length === 1 && tuiSink.frames.length === 1);

  assert.deepEqual(desktopSink.frames, [
    {
      kind: 'subscription.closed',
      hostEpoch: HOST_EPOCH,
      subscriptionId: desktopSubscription.subscriptionId,
      sequence: 1,
      reason: 'session_removed',
    },
  ]);
  assert.deepEqual(tuiSink.frames, [
    {
      kind: 'subscription.closed',
      hostEpoch: HOST_EPOCH,
      subscriptionId: tuiSubscription.subscriptionId,
      sequence: 1,
      reason: 'session_removed',
    },
  ]);
  coordinator.close();
});

test('open returns a bounded durable tail and an immutable active overlay', async () => {
  const durable: StoredMessage[] = [assistantMessage('durable')];
  const overlay = [assistantMessage('live overlay')];
  const coordinator = new SessionContinuityCoordinator(
    HOST_EPOCH,
    async () => canonical(),
    new SessionAdmissionGate(),
    undefined,
    transcriptReader(durable, overlay),
  );
  const connection = coordinator.attachConnection('connection-1', new RecordingSink());
  const opened = await open(coordinator, 'connection-1', {
    kind: 'tail',
    maxBytes: SESSION_TRANSCRIPT_BOOTSTRAP_MAX_BYTES,
  });
  connection.activate(opened.subscriptionId);
  assert.ok(opened.transcript);
  if (!opened.transcript) return;
  const client = new ClientSessionSubscription(
    opened,
    async () => undefined,
    async () => {
      throw new Error('bounded bootstrap unexpectedly required continuation');
    },
  );
  durable[0] = assistantMessage('mutated after open');
  overlay[0] = assistantMessage('mutated after open');
  assert.deepEqual(await client.loadTranscript((value) => value), [
    assistantMessage('live overlay'),
  ]);
  coordinator.close();
});

test('shares one immutable active overlay preparation until the Session changes', async () => {
  const baseReader = transcriptReader(
    [assistantMessage('durable')],
    [assistantMessage('overlay'.repeat(8 * 1024))],
  );
  let overlayReads = 0;
  const reader: SessionTranscriptReader = {
    ...baseReader,
    readActiveOverlay: async (...args) => {
      overlayReads += 1;
      return baseReader.readActiveOverlay(...args);
    },
  };
  const coordinator = new SessionContinuityCoordinator(
    HOST_EPOCH,
    async () => canonical(),
    new SessionAdmissionGate(),
    undefined,
    reader,
  );
  coordinator.attachConnection('connection-overlay-1', new RecordingSink());
  coordinator.attachConnection('connection-overlay-2', new RecordingSink());
  await open(coordinator, 'connection-overlay-1', {
    kind: 'tail',
    maxBytes: SESSION_TRANSCRIPT_BOOTSTRAP_MAX_BYTES,
  });
  await open(coordinator, 'connection-overlay-2', {
    kind: 'tail',
    maxBytes: SESSION_TRANSCRIPT_BOOTSTRAP_MAX_BYTES,
  });
  assert.equal(overlayReads, 1);

  await coordinator.acceptRuntimeEvent(SESSION_ID, 'run-1', textEvent(1));
  coordinator.attachConnection('connection-overlay-3', new RecordingSink());
  await open(coordinator, 'connection-overlay-3', {
    kind: 'tail',
    maxBytes: SESSION_TRANSCRIPT_BOOTSTRAP_MAX_BYTES,
  });
  assert.equal(overlayReads, 2);
  coordinator.close();
});

test('queues concurrent overlay preparation instead of rejecting an empty overlay', async () => {
  const firstRead = deferred<void>();
  let reads = 0;
  const reader = transcriptReader([]);
  const boundedReader: SessionTranscriptReader = {
    ...reader,
    readActiveOverlay: async () => {
      reads += 1;
      if (reads === 1) await firstRead.promise;
      return [];
    },
  };
  const coordinator = new SessionContinuityCoordinator(
    HOST_EPOCH,
    async (sessionId) => canonicalFor(sessionId),
    new SessionAdmissionGate(),
    undefined,
    boundedReader,
  );
  coordinator.attachConnection('connection-queued-1', new RecordingSink());
  coordinator.attachConnection('connection-queued-2', new RecordingSink());

  const first = openForSession(coordinator, 'connection-queued-1', 'session-queued-1');
  await waitFor(() => reads === 1);
  const second = openForSession(coordinator, 'connection-queued-2', 'session-queued-2');
  await delayImmediate();
  assert.equal(reads, 1);
  let runtimeEventAccepted = false;
  const acceptRuntimeEvent = coordinator
    .acceptRuntimeEvent('session-queued-2', 'run-1', previewEvent())
    .finally(() => {
      runtimeEventAccepted = true;
    });
  await delayImmediate();
  assert.equal(runtimeEventAccepted, true);
  await acceptRuntimeEvent;

  firstRead.resolve();
  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.ok(firstResult.transcript);
  assert.ok(secondResult.transcript);
  assert.equal(reads, 2);
  coordinator.close();
});

test('rechecks a reusable overlay cache after queued preparation reaches capacity', async () => {
  const firstCanonicalRead = deferred<void>();
  let canonicalReads = 0;
  let overlayReads = 0;
  const baseReader = transcriptReader([]);
  const reader: SessionTranscriptReader = {
    ...baseReader,
    readActiveOverlay: async (sessionId) => {
      overlayReads += 1;
      return [
        assistantMessage(
          sessionId === 'session-retained'
            ? 'x'.repeat(2 * 1024 * 1024)
            : 'x'.repeat(15 * 1024 * 1024),
        ),
      ];
    },
  };
  const coordinator = new SessionContinuityCoordinator(
    HOST_EPOCH,
    async (sessionId) => {
      if (sessionId === 'session-shared' && canonicalReads++ === 0) {
        await firstCanonicalRead.promise;
      }
      return canonicalFor(sessionId);
    },
    new SessionAdmissionGate(),
    undefined,
    reader,
  );
  coordinator.attachConnection('connection-retained', new RecordingSink());
  coordinator.attachConnection('connection-shared-1', new RecordingSink());
  coordinator.attachConnection('connection-shared-2', new RecordingSink());
  await openForSession(coordinator, 'connection-retained', 'session-retained');

  const first = openForSession(coordinator, 'connection-shared-1', 'session-shared');
  await delayImmediate();
  const second = openForSession(coordinator, 'connection-shared-2', 'session-shared');
  firstCanonicalRead.resolve();

  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.ok(firstResult.transcript);
  assert.ok(secondResult.transcript);
  assert.equal(overlayReads, 2);
  coordinator.close();
});

test('keeps a shared overlay retained while another subscription open consumes it', async () => {
  const durable = [
    {
      type: 'user' as const,
      id: 'durable-1',
      turnId: 'turn-1',
      ts: 1,
      text: 'history',
    },
  ];
  const baseReader = transcriptReader(durable, [assistantMessage('partial')]);
  const secondPageStarted = deferred<void>();
  const continueSecondPage = deferred<void>();
  let pageReads = 0;
  const reader: SessionTranscriptReader = {
    ...baseReader,
    readDurablePage: async (...args) => {
      pageReads += 1;
      if (pageReads === 2) {
        secondPageStarted.resolve();
        await continueSecondPage.promise;
      }
      return baseReader.readDurablePage(...args);
    },
  };
  const coordinator = new SessionContinuityCoordinator(
    HOST_EPOCH,
    async () => canonical(),
    new SessionAdmissionGate(),
    undefined,
    reader,
  );
  coordinator.attachConnection('connection-shared-overlay-1', new RecordingSink());
  coordinator.attachConnection('connection-shared-overlay-2', new RecordingSink());
  const first = await openForSession(coordinator, 'connection-shared-overlay-1', SESSION_ID);
  const second = openForSession(coordinator, 'connection-shared-overlay-2', SESSION_ID);
  await secondPageStarted.promise;

  assert.deepEqual(
    await coordinator.handlers['session.transcript.overlay.release'](
      { subscriptionId: first.subscriptionId },
      connectionContext('connection-shared-overlay-1'),
    ),
    { ok: true, result: { subscriptionId: first.subscriptionId } },
  );
  continueSecondPage.resolve();
  assert.ok((await second).transcript);
  coordinator.close();
});

test('cancels a queued overlay preparation when its connection closes', async () => {
  const firstRead = deferred<void>();
  let reads = 0;
  const reader = transcriptReader([]);
  const boundedReader: SessionTranscriptReader = {
    ...reader,
    readActiveOverlay: async () => {
      reads += 1;
      if (reads === 1) await firstRead.promise;
      return [];
    },
  };
  const coordinator = new SessionContinuityCoordinator(
    HOST_EPOCH,
    async (sessionId) => canonicalFor(sessionId),
    new SessionAdmissionGate(),
    undefined,
    boundedReader,
  );
  coordinator.attachConnection('connection-cancel-1', new RecordingSink());
  const queuedConnection = coordinator.attachConnection('connection-cancel-2', new RecordingSink());

  const first = openForSession(coordinator, 'connection-cancel-1', 'session-cancel-1');
  await waitFor(() => reads === 1);
  const queued = openForSession(coordinator, 'connection-cancel-2', 'session-cancel-2');
  await delayImmediate();
  queuedConnection.close();
  await assert.rejects(queued, /Session transcript is unavailable/);
  assert.equal(reads, 1);

  firstRead.resolve();
  assert.ok((await first).transcript);
  coordinator.close();
});

test('fails fast when retained active overlays leave no preparation capacity', async () => {
  let generation = 0;
  const baseReader = transcriptReader([]);
  const reader: SessionTranscriptReader = {
    ...baseReader,
    readActiveOverlay: async () => [
      assistantMessage(`${generation}:${'x'.repeat(15 * 1024 * 1024)}`),
    ],
  };
  const coordinator = new SessionContinuityCoordinator(
    HOST_EPOCH,
    async () => canonical(),
    new SessionAdmissionGate(),
    undefined,
    reader,
  );
  const opened: Array<{ abort(subscriptionId: string): void; subscriptionId: string }> = [];
  for (let index = 0; index < 2; index += 1) {
    const connection = coordinator.attachConnection(
      `connection-overlay-budget-${index}`,
      new RecordingSink(),
    );
    const result = await open(coordinator, `connection-overlay-budget-${index}`, {
      kind: 'tail',
      maxBytes: SESSION_TRANSCRIPT_BOOTSTRAP_MAX_BYTES,
    });
    opened.push({ abort: connection.abort, subscriptionId: result.subscriptionId });
    generation += 1;
    await coordinator.acceptRuntimeEvent(SESSION_ID, 'run-1', textEvent(index + 1));
  }

  coordinator.attachConnection('connection-overlay-budget-full', new RecordingSink());
  const unavailable = await coordinator.handlers['subscription.open'](
    {
      sessionId: SESSION_ID,
      transcript: { kind: 'tail', maxBytes: SESSION_TRANSCRIPT_BOOTSTRAP_MAX_BYTES },
    },
    connectionContext('connection-overlay-budget-full'),
  );
  assert.deepEqual(unavailable, {
    ok: false,
    error: {
      code: 'operation_unavailable',
      message: 'Runtime Host transcript overlay capacity reached',
    },
  });

  opened[0]!.abort(opened[0]!.subscriptionId);
  const recovered = await open(coordinator, 'connection-overlay-budget-full', {
    kind: 'tail',
    maxBytes: SESSION_TRANSCRIPT_BOOTSTRAP_MAX_BYTES,
  });
  assert.ok(recovered.transcript);
  coordinator.close();
});

test('releases retained overlays after their materialization is acknowledged', async () => {
  let generation = 0;
  const baseReader = transcriptReader([]);
  const reader: SessionTranscriptReader = {
    ...baseReader,
    readActiveOverlay: async () => [
      assistantMessage(`${generation}:${'x'.repeat(15 * 1024 * 1024)}`),
    ],
  };
  const coordinator = new SessionContinuityCoordinator(
    HOST_EPOCH,
    async () => canonical(),
    new SessionAdmissionGate(),
    undefined,
    reader,
  );

  for (let index = 0; index < 3; index += 1) {
    const connectionId = `connection-consumed-overlay-${index}`;
    coordinator.attachConnection(connectionId, new RecordingSink());
    const opened = await open(coordinator, connectionId, {
      kind: 'tail',
      maxBytes: SESSION_TRANSCRIPT_BOOTSTRAP_MAX_BYTES,
    });
    await consumeBootstrapOverlay(coordinator, connectionId, opened);
    generation += 1;
    await coordinator.acceptRuntimeEvent(SESSION_ID, 'run-1', textEvent(index + 1));
  }
  coordinator.close();
});

test('treats overlay release as idempotent after teardown without crossing connection ownership', async () => {
  const coordinator = new SessionContinuityCoordinator(
    HOST_EPOCH,
    async () => canonical(),
    new SessionAdmissionGate(),
    undefined,
    transcriptReader([], [assistantMessage('partial')]),
  );
  const owner = coordinator.attachConnection('connection-release-owner', new RecordingSink());
  coordinator.attachConnection('connection-release-foreign', new RecordingSink());
  const opened = await openForSession(coordinator, 'connection-release-owner', SESSION_ID);
  const input = { subscriptionId: opened.subscriptionId };

  assert.deepEqual(
    await coordinator.handlers['session.transcript.overlay.release'](
      input,
      connectionContext('connection-release-foreign'),
    ),
    {
      ok: false,
      error: { code: 'not_found', message: 'Session subscription was not found' },
    },
  );
  owner.abort(opened.subscriptionId);
  assert.deepEqual(
    await coordinator.handlers['session.transcript.overlay.release'](
      input,
      connectionContext('connection-release-owner'),
    ),
    { ok: true, result: input },
  );
  coordinator.close();
});

test('opens a terminal Session without reserving active overlay preparation capacity', async () => {
  const overlay = assistantMessage('x'.repeat(9 * 1024 * 1024));
  const coordinator = new SessionContinuityCoordinator(
    HOST_EPOCH,
    async (sessionId) =>
      sessionId === 'session-terminal'
        ? canonicalFor(sessionId, { rootTurn: null })
        : canonicalFor(sessionId),
    new SessionAdmissionGate(),
    undefined,
    transcriptReader([], [overlay]),
  );
  for (const index of [1, 2]) {
    const connectionId = `connection-retained-${index}`;
    coordinator.attachConnection(connectionId, new RecordingSink());
    await openForSession(coordinator, connectionId, `session-retained-${index}`);
  }
  coordinator.attachConnection('connection-terminal', new RecordingSink());

  const opened = await openForSession(coordinator, 'connection-terminal', 'session-terminal');

  assert.equal(opened.transcript?.overlayMessageCount, 0);
  coordinator.close();
});

test('releases the active overlay budget after the last transcript subscriber leaves', async () => {
  const overlay = assistantMessage('x'.repeat(15 * 1024 * 1024));
  const coordinator = new SessionContinuityCoordinator(
    HOST_EPOCH,
    async (sessionId) => canonicalFor(sessionId),
    new SessionAdmissionGate(),
    undefined,
    transcriptReader([], [overlay]),
  );

  for (let index = 0; index < 5; index += 1) {
    const connectionId = `connection-idle-overlay-${index}`;
    const sessionId = `session-idle-overlay-${index}`;
    const connection = coordinator.attachConnection(connectionId, new RecordingSink());
    const outcome = await coordinator.handlers['subscription.open'](
      {
        sessionId,
        transcript: { kind: 'tail', maxBytes: SESSION_TRANSCRIPT_BOOTSTRAP_MAX_BYTES },
      },
      connectionContext(connectionId),
    );
    assert.equal(outcome.ok, true);
    if (!outcome.ok) continue;
    connection.abort(outcome.result.subscriptionId);
  }
  coordinator.close();
});

test('releases the active overlay budget when subscription open fails after preparation', async () => {
  const overlay = assistantMessage('x'.repeat(15 * 1024 * 1024));
  const baseReader = transcriptReader([], [overlay]);
  const reader: SessionTranscriptReader = {
    ...baseReader,
    readDurableHighWater: async () => 0,
    readDurablePage: async () => {
      throw new Error('injected durable bootstrap failure');
    },
  };
  const coordinator = new SessionContinuityCoordinator(
    HOST_EPOCH,
    async (sessionId) => canonicalFor(sessionId),
    new SessionAdmissionGate(),
    undefined,
    reader,
  );

  for (let index = 0; index < 5; index += 1) {
    const connectionId = `connection-failed-overlay-${index}`;
    coordinator.attachConnection(connectionId, new RecordingSink());
    const outcome = await coordinator.handlers['subscription.open'](
      {
        sessionId: `session-failed-overlay-${index}`,
        transcript: { kind: 'tail', maxBytes: SESSION_TRANSCRIPT_BOOTSTRAP_MAX_BYTES },
      },
      connectionContext(connectionId),
    );
    assert.deepEqual(outcome, {
      ok: false,
      error: { code: 'persistence_failed', message: 'Session transcript is unavailable' },
    });
  }
  coordinator.close();
});

test('releases the active overlay budget when its connection closes during open', async () => {
  const durable = [assistantMessage('durable')];
  const overlay = assistantMessage('x'.repeat(15 * 1024 * 1024));
  const baseReader = transcriptReader(durable, [overlay]);
  const pageStarted = deferred<void>();
  const continuePage = deferred<void>();
  let delayFirstPage = true;
  const reader: SessionTranscriptReader = {
    ...baseReader,
    readDurablePage: async (...args) => {
      if (delayFirstPage) {
        delayFirstPage = false;
        pageStarted.resolve();
        await continuePage.promise;
      }
      return baseReader.readDurablePage(...args);
    },
  };
  const coordinator = new SessionContinuityCoordinator(
    HOST_EPOCH,
    async (sessionId) => canonicalFor(sessionId),
    new SessionAdmissionGate(),
    undefined,
    reader,
  );
  const interrupted = coordinator.attachConnection(
    'connection-interrupted-overlay',
    new RecordingSink(),
  );
  const opening = coordinator.handlers['subscription.open'](
    {
      sessionId: 'session-interrupted-overlay',
      transcript: { kind: 'tail', maxBytes: SESSION_TRANSCRIPT_BOOTSTRAP_MAX_BYTES },
    },
    connectionContext('connection-interrupted-overlay'),
  );
  await pageStarted.promise;
  interrupted.close();
  continuePage.resolve();
  await assert.rejects(opening, /connection closed during subscription open/);

  for (let index = 0; index < 2; index += 1) {
    const connectionId = `connection-after-interruption-${index}`;
    coordinator.attachConnection(connectionId, new RecordingSink());
    const outcome = await coordinator.handlers['subscription.open'](
      {
        sessionId: `session-after-interruption-${index}`,
        transcript: { kind: 'tail', maxBytes: SESSION_TRANSCRIPT_BOOTSTRAP_MAX_BYTES },
      },
      connectionContext(connectionId),
    );
    assert.equal(outcome.ok, true);
  }
  coordinator.close();
});

test('fits a transcript bootstrap inside a near-limit subscription open response', async () => {
  const durable = Array.from({ length: 300 }, (_, index) => ({
    type: 'system_note' as const,
    id: `message-${index}`,
    ts: index + 1,
    kind: 'session_start' as const,
  }));
  const projection = canonical({
    queue: {
      hostEpoch: HOST_EPOCH,
      queueRevision: 1,
      steering: [],
      followup: [
        {
          entryId: 'entry-1',
          messageId: 'queued-message-1',
          content: {
            text: 'q'.repeat(48 * 1024),
            quotes: [{ text: 'r'.repeat(2 * 1024), label: 'Assistant' }],
          },
          placement: 'next_turn',
          state: 'queued',
        },
      ],
    },
  });
  const coordinator = new SessionContinuityCoordinator(
    HOST_EPOCH,
    async () => projection,
    new SessionAdmissionGate(),
    undefined,
    transcriptReader(durable),
  );
  coordinator.attachConnection('connection-open-budget', new RecordingSink());
  const opened = await open(coordinator, 'connection-open-budget', {
    kind: 'tail',
    maxBytes: SESSION_TRANSCRIPT_BOOTSTRAP_MAX_BYTES,
  });
  assert.ok(opened.transcript);
  const encoded = encodeProtocolMessage({
    requestId: 'request-1',
    operation: 'subscription.open',
    ok: true,
    result: opened,
  });
  assert.ok(encoded.byteLength <= RUNTIME_HOST_MAX_MESSAGE_BYTES);
  coordinator.close();
});

test('open reconciles the active assistant prefix into its overlay seed', async () => {
  const coordinator = new SessionContinuityCoordinator(
    HOST_EPOCH,
    async () => canonical(),
    new SessionAdmissionGate(),
    undefined,
    transcriptReader([assistantMessage('chunk-1')], [assistantMessage('chunk-1')]),
  );
  await coordinator.acceptRuntimeEvent(SESSION_ID, 'run-1', textEvent(1));
  await coordinator.acceptRuntimeEvent(SESSION_ID, 'run-1', textEvent(2));
  coordinator.attachConnection('connection-live-prefix', new RecordingSink());
  const opened = await open(coordinator, 'connection-live-prefix', {
    kind: 'tail',
    maxBytes: SESSION_TRANSCRIPT_BOOTSTRAP_MAX_BYTES,
  });
  const client = new ClientSessionSubscription(
    opened,
    async () => undefined,
    async () => {
      throw new Error('bounded bootstrap unexpectedly required continuation');
    },
  );
  assert.deepEqual(await client.loadTranscript((value) => value), [
    assistantMessage('chunk-1chunk-2'),
  ]);
  coordinator.close();
});

test('a non-prefix durable final replaces a stale active assistant draft', async () => {
  const coordinator = new SessionContinuityCoordinator(
    HOST_EPOCH,
    async () => canonical(),
    new SessionAdmissionGate(),
    undefined,
    transcriptReader([assistantMessage('authoritative final')], [assistantMessage('draft')]),
  );
  await coordinator.acceptRuntimeEvent(SESSION_ID, 'run-1', {
    ...textEvent(1),
    text: 'draft',
  });
  coordinator.attachConnection('connection-final-handoff', new RecordingSink());
  const opened = await open(coordinator, 'connection-final-handoff', {
    kind: 'tail',
    maxBytes: SESSION_TRANSCRIPT_BOOTSTRAP_MAX_BYTES,
  });
  const client = new ClientSessionSubscription(
    opened,
    async () => undefined,
    async () => {
      throw new Error('bounded bootstrap unexpectedly required continuation');
    },
  );
  assert.deepEqual(await client.loadTranscript((value) => value), [
    assistantMessage('authoritative final'),
  ]);
  coordinator.close();
});

test('binds durable handoff reconciliation to the bootstrap watermark', async () => {
  const durable: StoredMessage[] = [];
  const partial = assistantMessage('part');
  const final = assistantMessage('partial complete');
  const baseReader = transcriptReader(durable, [partial]);
  const reader: SessionTranscriptReader = {
    ...baseReader,
    readDurableMessagesById: async (...args) => {
      const messages = await baseReader.readDurableMessagesById(...args);
      durable.push(final);
      return messages;
    },
  };
  const coordinator = new SessionContinuityCoordinator(
    HOST_EPOCH,
    async () => canonical(),
    new SessionAdmissionGate(),
    undefined,
    reader,
  );
  await coordinator.acceptRuntimeEvent(SESSION_ID, 'run-1', {
    ...textEvent(1),
    text: partial.text,
  });
  coordinator.attachConnection('connection-fixed-handoff', new RecordingSink());
  const opened = await open(coordinator, 'connection-fixed-handoff', {
    kind: 'tail',
    maxBytes: SESSION_TRANSCRIPT_BOOTSTRAP_MAX_BYTES,
  });
  assert.equal(opened.transcript?.throughSequence, null);
  const client = new ClientSessionSubscription(
    opened,
    async () => undefined,
    async () => {
      throw new Error('the fixed empty watermark unexpectedly exposed a later durable row');
    },
  );
  assert.deepEqual(await client.loadTranscript((value) => value), [partial]);
  coordinator.close();
});

test('large transcript messages are paged and cursors remain subscription-owned', async () => {
  const message = assistantMessage('界'.repeat(20_000));
  const coordinator = new SessionContinuityCoordinator(
    HOST_EPOCH,
    async () => canonical(),
    new SessionAdmissionGate(),
    undefined,
    transcriptReader([message]),
  );
  const owner = coordinator.attachConnection('connection-owner', new RecordingSink());
  const sibling = coordinator.attachConnection('connection-sibling', new RecordingSink());
  const opened = await open(coordinator, 'connection-owner', {
    kind: 'tail',
    maxBytes: SESSION_TRANSCRIPT_BOOTSTRAP_MAX_BYTES,
  });
  assert.ok(opened.transcript?.durable.nextCursor);
  if (!opened.transcript?.durable.nextCursor) return;
  const firstCursor = opened.transcript.durable.nextCursor;
  const client = new ClientSessionSubscription(
    opened,
    async () => undefined,
    async (input) => {
      const next = await coordinator.handlers['session.transcript.page'](
        input,
        connectionContext('connection-owner'),
      );
      if (!next.ok) throw new Error(next.error.message);
      return next.result;
    },
  );
  assert.deepEqual(await client.loadTranscript((value) => value), [message]);

  const foreign = await coordinator.handlers['session.transcript.page'](
    {
      subscriptionId: opened.subscriptionId,
      source: 'durable',
      direction: 'older',
      throughSequence: opened.transcript.throughSequence,
      cursor: firstCursor,
      anchorSequence: null,
      maxBytes: 1024,
    },
    connectionContext('connection-sibling'),
  );
  assert.deepEqual(foreign, {
    ok: false,
    error: { code: 'not_found', message: 'Session subscription was not found' },
  });
  owner.close();
  sibling.close();
  coordinator.close();
});

test('an in-flight transcript page cannot outlive its owning connection', async () => {
  const message = assistantMessage('界'.repeat(20_000));
  const continued = deferred<void>();
  const baseReader = transcriptReader([message]);
  let reads = 0;
  const reader: SessionTranscriptReader = {
    ...baseReader,
    readDurablePage: async (sessionId, request) => {
      reads += 1;
      if (reads > 1) await continued.promise;
      return baseReader.readDurablePage(sessionId, request);
    },
  };
  const coordinator = new SessionContinuityCoordinator(
    HOST_EPOCH,
    async () => canonical(),
    new SessionAdmissionGate(),
    undefined,
    reader,
  );
  const connection = coordinator.attachConnection('connection-1', new RecordingSink());
  const opened = await open(coordinator, 'connection-1', {
    kind: 'tail',
    maxBytes: SESSION_TRANSCRIPT_BOOTSTRAP_MAX_BYTES,
  });
  const cursor = opened.transcript?.durable.nextCursor;
  assert.ok(cursor);
  if (!opened.transcript || !cursor) return;
  const reading = coordinator.handlers['session.transcript.page'](
    {
      subscriptionId: opened.subscriptionId,
      source: 'durable',
      direction: 'older',
      throughSequence: opened.transcript.throughSequence,
      cursor,
      anchorSequence: null,
      maxBytes: 1024,
    },
    connectionContext('connection-1'),
  );
  await delayImmediate();
  connection.close();
  continued.resolve();
  assert.deepEqual(await reading, {
    ok: false,
    error: { code: 'not_found', message: 'Session subscription was not found' },
  });
  coordinator.close();
});

test('a durable append refresh advances transcript before its completion event', async () => {
  const durable = [assistantMessage('first')];
  const reader = transcriptReader(durable);
  const coordinator = new SessionContinuityCoordinator(
    HOST_EPOCH,
    async () => canonical(),
    new SessionAdmissionGate(),
    undefined,
    reader,
  );
  const sink = new RecordingSink();
  const connection = coordinator.attachConnection('connection-1', sink);
  const opened = await open(coordinator, 'connection-1', {
    kind: 'tail',
    maxBytes: SESSION_TRANSCRIPT_BOOTSTRAP_MAX_BYTES,
  });
  connection.activate(opened.subscriptionId);
  durable.push({ ...assistantMessage('second'), id: 'message-2' });
  coordinator.enqueueCanonicalRefresh(SESSION_ID);
  await coordinator.acceptRuntimeEvent(
    SESSION_ID,
    'run-1',
    textCompleteEvent('message-2', 'second'),
  );
  await waitFor(() => sink.frames.length >= 2);
  assert.equal(sink.frames[0]?.kind, 'subscription.transcript_advanced');
  assert.ok(sink.frames.slice(1).every((frame) => frame.kind === 'subscription.session_delta'));
  coordinator.close();
});

test('absolute live offsets survive a gap with no connected subscribers', async () => {
  const coordinator = new SessionContinuityCoordinator(
    HOST_EPOCH,
    async () => canonical(),
    new SessionAdmissionGate(),
  );
  const firstConnection = coordinator.attachConnection('connection-first', new RecordingSink());
  const first = await open(coordinator, 'connection-first');
  firstConnection.activate(first.subscriptionId);
  await coordinator.acceptRuntimeEvent(SESSION_ID, 'run-1', textEvent(1));
  firstConnection.close();
  await delayImmediate();

  await coordinator.acceptRuntimeEvent(SESSION_ID, 'run-1', textEvent(2));
  const sink = new RecordingSink();
  const secondConnection = coordinator.attachConnection('connection-second', sink);
  const second = await open(coordinator, 'connection-second');
  secondConnection.activate(second.subscriptionId);
  await coordinator.acceptRuntimeEvent(SESSION_ID, 'run-1', textEvent(3));
  await waitFor(() => sink.frames.length === 1);

  const frame = sink.frames[0];
  assert.equal(frame?.kind, 'subscription.session_delta');
  if (frame?.kind === 'subscription.session_delta') {
    assert.equal(frame.delta.startOffset, 'chunk-1'.length + 'chunk-2'.length);
  }
  coordinator.close();
});

test('rejoin seeds tool_result_preview at the open nextSequence without sequence_gap', async () => {
  const coordinator = new SessionContinuityCoordinator(
    HOST_EPOCH,
    async () => canonical(),
    new SessionAdmissionGate(),
  );
  await coordinator.acceptRuntimeEvent(SESSION_ID, 'run-1', previewEvent());

  const sink = new RecordingSink();
  const connection = coordinator.attachConnection('connection-rejoin', sink);
  const opened = await open(coordinator, 'connection-rejoin');
  assert.equal(opened.nextSequence, 1);

  connection.activate(opened.subscriptionId);
  await delayImmediate();
  assert.equal(sink.frames.length, 1);
  assert.equal(sink.frames[0]?.sequence, 1);
  assert.equal(sink.frames[0]?.kind, 'subscription.session_event');
  if (sink.frames[0]?.kind !== 'subscription.session_event') return;
  assert.equal(sink.frames[0].event.type, 'tool_result_preview');

  const client = new ClientSessionSubscription(
    opened,
    async () => {},
    async () => {
      throw new Error('transcript unused');
    },
  );
  assert.doesNotThrow(() => client.accept(sink.frames[0]!));

  connection.abort(opened.subscriptionId);
  coordinator.close();
});

test('tool_result clears retained tool_result_preview so a later open does not seed it', async () => {
  const coordinator = new SessionContinuityCoordinator(
    HOST_EPOCH,
    async () => canonical(),
    new SessionAdmissionGate(),
  );
  await coordinator.acceptRuntimeEvent(SESSION_ID, 'run-1', previewEvent());
  await coordinator.acceptRuntimeEvent(SESSION_ID, 'run-1', {
    type: 'tool_result',
    id: 'result-1',
    turnId: 'turn-1',
    ts: 2,
    toolUseId: 'tool-1',
    isError: false,
    content: { kind: 'text', text: '' },
  });

  const sink = new RecordingSink();
  const connection = coordinator.attachConnection('connection-after-settle', sink);
  const opened = await open(coordinator, 'connection-after-settle');
  assert.equal(opened.nextSequence, 1);
  connection.activate(opened.subscriptionId);
  await delayImmediate();
  assert.equal(
    sink.frames.some(
      (frame) =>
        frame.kind === 'subscription.session_event' && frame.event.type === 'tool_result_preview',
    ),
    false,
  );

  connection.abort(opened.subscriptionId);
  coordinator.close();
});

class RecordingSink implements SessionContinuityFrameSink {
  readonly frames: SubscriptionFrame[] = [];

  async send(frame: SubscriptionFrame): Promise<void> {
    this.frames.push(frame);
  }
}

function textCompleteEvent(messageId: string, text: string) {
  return {
    type: 'text_complete' as const,
    id: `text_complete-${messageId}`,
    turnId: 'turn-1',
    ts: 1,
    messageId,
    text,
  };
}

async function open(
  coordinator: SessionContinuityCoordinator,
  connectionId: string,
  transcript: { readonly kind: 'none' } | { readonly kind: 'tail'; readonly maxBytes: number } = {
    kind: 'none',
  },
) {
  const outcome = await coordinator.handlers['subscription.open'](
    { sessionId: SESSION_ID, transcript },
    connectionContext(connectionId),
  );
  if (!outcome.ok) throw new Error(outcome.error.message);
  assert.equal(outcome.ok, true);
  return outcome.result;
}

async function openForSession(
  coordinator: SessionContinuityCoordinator,
  connectionId: string,
  sessionId: string,
) {
  const outcome = await coordinator.handlers['subscription.open'](
    {
      sessionId,
      transcript: { kind: 'tail', maxBytes: SESSION_TRANSCRIPT_BOOTSTRAP_MAX_BYTES },
    },
    connectionContext(connectionId),
  );
  if (!outcome.ok) throw new Error(outcome.error.message);
  return outcome.result;
}

async function consumeBootstrapOverlay(
  coordinator: SessionContinuityCoordinator,
  connectionId: string,
  opened: Awaited<ReturnType<typeof open>>,
): Promise<void> {
  assert.ok(opened.transcript);
  let cursor = opened.transcript.overlay.nextCursor;
  let finalCursor: string | null = null;
  while (cursor !== null) {
    finalCursor = cursor;
    const outcome = await coordinator.handlers['session.transcript.page'](
      {
        subscriptionId: opened.subscriptionId,
        source: 'overlay',
        direction: 'older',
        throughSequence: opened.transcript.throughSequence,
        cursor,
        anchorSequence: null,
        maxBytes: SESSION_TRANSCRIPT_PAGE_MAX_BYTES,
      },
      connectionContext(connectionId),
    );
    assert.equal(outcome.ok, true);
    if (!outcome.ok) throw new Error('Transcript overlay page failed');
    if (outcome.result.nextCursor === null) {
      assert.deepEqual(
        await coordinator.handlers['session.transcript.page'](
          {
            subscriptionId: opened.subscriptionId,
            source: 'overlay',
            direction: 'older',
            throughSequence: opened.transcript.throughSequence,
            cursor,
            anchorSequence: null,
            maxBytes: SESSION_TRANSCRIPT_PAGE_MAX_BYTES,
          },
          connectionContext(connectionId),
        ),
        outcome,
      );
    }
    cursor = outcome.result.nextCursor;
  }
  const released = await coordinator.handlers['session.transcript.overlay.release'](
    { subscriptionId: opened.subscriptionId },
    connectionContext(connectionId),
  );
  assert.deepEqual(released, {
    ok: true,
    result: { subscriptionId: opened.subscriptionId },
  });
  assert.deepEqual(
    await coordinator.handlers['session.transcript.overlay.release'](
      { subscriptionId: opened.subscriptionId },
      connectionContext(connectionId),
    ),
    released,
  );
  assert.ok(finalCursor);
  assert.deepEqual(
    await coordinator.handlers['session.transcript.page'](
      {
        subscriptionId: opened.subscriptionId,
        source: 'overlay',
        direction: 'older',
        throughSequence: opened.transcript.throughSequence,
        cursor: finalCursor,
        anchorSequence: null,
        maxBytes: SESSION_TRANSCRIPT_PAGE_MAX_BYTES,
      },
      connectionContext(connectionId),
    ),
    {
      ok: false,
      error: { code: 'invalid_request', message: 'Transcript overlay has been released' },
    },
  );
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
  overrides: {
    lastUsedAt?: number;
    rootTurn?: CanonicalSessionProjection['rootTurn'];
    interactions?: CanonicalSessionProjection['interactions'];
    queue?: CanonicalSessionProjection['queue'];
  } = {},
): CanonicalSessionProjection {
  return {
    session: {
      sessionId: SESSION_ID,
      metadataRevision: 1,
      status: 'active',
      createdAt: 1,
      lastUsedAt: overrides.lastUsedAt ?? 1,
      isArchived: false,
    },
    rootTurn:
      overrides.rootTurn === undefined
        ? { sessionId: SESSION_ID, turnId: 'turn-1', runId: 'run-1', status: 'running' }
        : overrides.rootTurn,
    goal: null,
    queue: overrides.queue ?? {
      hostEpoch: HOST_EPOCH,
      queueRevision: 0,
      steering: [],
      followup: [],
    },
    interactions: overrides.interactions ?? { pending: [] },
  };
}

function canonicalFor(
  sessionId: string,
  overrides: Parameters<typeof canonical>[0] = {},
): CanonicalSessionProjection {
  const projection = canonical(overrides);
  return {
    ...projection,
    session: { ...projection.session, sessionId },
    rootTurn: projection.rootTurn ? { ...projection.rootTurn, sessionId } : null,
  };
}

function shellRunUpdate(overrides: Partial<ShellRunUpdate> = {}): ShellRunUpdate {
  return {
    sessionId: SESSION_ID,
    ownership: { kind: 'local' },
    sourceTurnId: 'turn-1',
    sourceToolCallId: 'tool-1',
    result: {
      kind: 'shell_run',
      ref: 'shell:run-1',
      mode: 'pipes',
      status: 'running',
      cwd: '/workspace',
      cmd: 'sleep 60',
      startedAt: 1,
      updatedAt: 2,
      revision: 2,
      output: {
        mode: 'pipes',
        stdout: 'ready',
        stderr: '',
        stdoutTruncated: false,
        stderrTruncated: false,
        redacted: false,
      },
    },
    ...overrides,
  };
}

function pendingInteraction() {
  return {
    schemaVersion: 1 as const,
    interactionId: 'interaction-1',
    sessionId: SESSION_ID,
    turnId: 'turn-1',
    runId: 'run-1',
    revision: 1 as const,
    request: {
      kind: 'question' as const,
      toolUseId: 'tool-1',
      questions: [
        {
          question: 'Continue?',
          options: [
            { label: 'Yes', description: 'Continue execution' },
            { label: 'No', description: 'Stop execution' },
          ],
        },
      ],
    },
    status: 'pending' as const,
    outcome: null,
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

function thinkingEvent(
  type: 'thinking_delta' | 'thinking_complete',
  messageId: string,
  text: string,
) {
  return {
    type,
    id: `${type}-${messageId}`,
    turnId: 'turn-1',
    ts: 1,
    messageId,
    text,
  };
}

function previewEvent() {
  return {
    type: 'tool_result_preview' as const,
    id: 'preview-1',
    turnId: 'turn-1',
    ts: 1,
    toolUseId: 'tool-1',
    isError: false,
    content: {
      kind: 'subagent' as const,
      childSessionId: 'child-1',
      agentName: 'Local Read',
      turnId: 'child-turn',
      status: 'running' as const,
      permissionMode: 'explore' as const,
    },
  };
}

function assistantMessage(text: string): Extract<StoredMessage, { type: 'assistant' }> {
  return {
    type: 'assistant',
    id: 'message-1',
    turnId: 'turn-1',
    ts: 1,
    text,
    modelId: 'test-model',
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
