import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createReadOnlyPermissionProfile } from '@maka/core';
import { HostSessionTranscriptCoordinator } from '../server/session-transcript-coordinator.js';
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
