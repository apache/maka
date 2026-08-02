import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createReadOnlyPermissionProfile } from '@maka/core';
import { SESSION_TRANSCRIPT_CHUNK_MAX_BYTES } from '../protocol/index.js';
import {
  HostSessionTranscriptCoordinator,
  MAX_TRANSCRIPT_SNAPSHOT_BYTES,
} from '../server/session-transcript-coordinator.js';
import { SessionAdmissionGate } from '../server/session-admission-gate.js';

test('Session transcript continuation detects an execution-boundary-only change', async () => {
  let boundaryRevision = 0;
  const coordinator = new HostSessionTranscriptCoordinator({
    store: {
      async readHeaderRecordSnapshot() {
        return {
          revision: 1,
          committedAt: 1,
          header: {} as never,
        };
      },
      async readMessagesSnapshot() {
        return [
          {
            type: 'user' as const,
            id: 'message-1',
            turnId: 'turn-1',
            ts: 1,
            text: 'hello',
          },
        ];
      },
      async readExecutionBoundary() {
        return {
          kind: 'managed' as const,
          profile: createReadOnlyPermissionProfile(),
          revision: boundaryRevision,
        };
      },
    },
    admission: new SessionAdmissionGate(),
  });

  const initial = await coordinator.handlers['session.transcript.query'](
    { kind: 'start', sessionId: 'session-1' },
    {} as never,
  );
  assert.equal(initial.ok, true);
  if (!initial.ok || initial.result.kind !== 'chunk') return;
  assert.equal(initial.result.boundary.revision, 0);

  boundaryRevision = 1;
  const continuation = await coordinator.handlers['session.transcript.query'](
    {
      kind: 'continue',
      sessionId: 'session-1',
      snapshotId: initial.result.snapshotId,
      revision: initial.result.revision,
      boundaryRevision: initial.result.boundary.revision,
      messageIndex: 0,
      byteOffset: 1,
    },
    {} as never,
  );
  assert.deepEqual(continuation, {
    ok: true,
    result: {
      kind: 'revision_changed',
      expectedRevision: 1,
      actualRevision: 1,
      expectedBoundaryRevision: 0,
      actualBoundaryRevision: 1,
    },
  });
});

test('Session transcript continuations reuse one immutable message snapshot', async () => {
  let messageReads = 0;
  const coordinator = new HostSessionTranscriptCoordinator({
    store: {
      async readHeaderRecordSnapshot() {
        return { revision: 1, committedAt: 1, header: {} as never };
      },
      async readMessagesSnapshot() {
        messageReads += 1;
        return [
          {
            type: 'user' as const,
            id: 'message-1',
            turnId: 'turn-1',
            ts: 1,
            text: 'x'.repeat(SESSION_TRANSCRIPT_CHUNK_MAX_BYTES),
          },
        ];
      },
      async readExecutionBoundary() {
        return {
          kind: 'managed' as const,
          profile: createReadOnlyPermissionProfile(),
          revision: 0,
        };
      },
    },
    admission: new SessionAdmissionGate(),
  });

  const initial = await coordinator.handlers['session.transcript.query'](
    { kind: 'start', sessionId: 'session-1' },
    {} as never,
  );
  assert.equal(initial.ok, true);
  if (!initial.ok || initial.result.kind !== 'chunk' || initial.result.next === null) return;

  const continuation = await coordinator.handlers['session.transcript.query'](
    {
      kind: 'continue',
      sessionId: 'session-1',
      snapshotId: initial.result.snapshotId,
      revision: initial.result.revision,
      boundaryRevision: initial.result.boundary.revision,
      ...initial.result.next,
    },
    {} as never,
  );

  assert.equal(continuation.ok, true);
  assert.equal(messageReads, 1);
});

test('Session transcript snapshot leases evict the oldest continuation', async () => {
  const coordinator = new HostSessionTranscriptCoordinator({
    store: {
      async readHeaderRecordSnapshot() {
        return { revision: 1, committedAt: 1, header: {} as never };
      },
      async readMessagesSnapshot() {
        return [
          {
            type: 'user' as const,
            id: 'message-1',
            turnId: 'turn-1',
            ts: 1,
            text: 'x'.repeat(SESSION_TRANSCRIPT_CHUNK_MAX_BYTES),
          },
        ];
      },
      async readExecutionBoundary() {
        return {
          kind: 'managed' as const,
          profile: createReadOnlyPermissionProfile(),
          revision: 0,
        };
      },
    },
    admission: new SessionAdmissionGate(),
  });
  const starts = await Promise.all(
    Array.from({ length: 9 }, () =>
      coordinator.handlers['session.transcript.query'](
        { kind: 'start', sessionId: 'session-1' },
        {} as never,
      ),
    ),
  );
  const first = starts[0];
  assert.equal(first?.ok, true);
  if (!first?.ok || first.result.kind !== 'chunk' || first.result.next === null) return;

  const continuation = await coordinator.handlers['session.transcript.query'](
    {
      kind: 'continue',
      sessionId: 'session-1',
      snapshotId: first.result.snapshotId,
      revision: first.result.revision,
      boundaryRevision: first.result.boundary.revision,
      ...first.result.next,
    },
    {} as never,
  );

  assert.deepEqual(continuation, {
    ok: true,
    result: { kind: 'snapshot_expired', snapshotId: first.result.snapshotId },
  });
});

test('Session transcript rejects a snapshot that exceeds the retained byte bound', async () => {
  const coordinator = new HostSessionTranscriptCoordinator({
    store: {
      async readHeaderRecordSnapshot() {
        return { revision: 1, committedAt: 1, header: {} as never };
      },
      async readMessagesSnapshot() {
        return [
          {
            type: 'user' as const,
            id: 'message-1',
            turnId: 'turn-1',
            ts: 1,
            text: 'x'.repeat(MAX_TRANSCRIPT_SNAPSHOT_BYTES),
          },
        ];
      },
      async readExecutionBoundary() {
        return {
          kind: 'managed' as const,
          profile: createReadOnlyPermissionProfile(),
          revision: 0,
        };
      },
    },
    admission: new SessionAdmissionGate(),
  });

  const result = await coordinator.handlers['session.transcript.query'](
    { kind: 'start', sessionId: 'session-1' },
    {} as never,
  );

  assert.deepEqual(result, {
    ok: false,
    error: {
      code: 'operation_unavailable',
      message: 'Session transcript exceeds the live snapshot byte limit',
    },
  });
});

test('Session transcript expires an abandoned continuation without another query', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
  try {
    const coordinator = new HostSessionTranscriptCoordinator({
      store: {
        async readHeaderRecordSnapshot() {
          return { revision: 1, committedAt: 1, header: {} as never };
        },
        async readMessagesSnapshot() {
          return [
            {
              type: 'user' as const,
              id: 'message-1',
              turnId: 'turn-1',
              ts: 1,
              text: 'x'.repeat(SESSION_TRANSCRIPT_CHUNK_MAX_BYTES),
            },
          ];
        },
        async readExecutionBoundary() {
          return {
            kind: 'managed' as const,
            profile: createReadOnlyPermissionProfile(),
            revision: 0,
          };
        },
      },
      admission: new SessionAdmissionGate(),
    });
    const initial = await coordinator.handlers['session.transcript.query'](
      { kind: 'start', sessionId: 'session-1' },
      {} as never,
    );
    assert.equal(initial.ok, true);
    if (!initial.ok || initial.result.kind !== 'chunk' || initial.result.next === null) return;

    t.mock.timers.tick(60_000);
    const continuation = await coordinator.handlers['session.transcript.query'](
      {
        kind: 'continue',
        sessionId: 'session-1',
        snapshotId: initial.result.snapshotId,
        revision: initial.result.revision,
        boundaryRevision: initial.result.boundary.revision,
        ...initial.result.next,
      },
      {} as never,
    );

    assert.deepEqual(continuation, {
      ok: true,
      result: { kind: 'snapshot_expired', snapshotId: initial.result.snapshotId },
    });
  } finally {
    t.mock.timers.reset();
  }
});
