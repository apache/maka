import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createReadOnlyPermissionProfile, createWorkspaceWritePermissionProfile } from '@maka/core/permission-profile';
import type { ExecutionBoundary } from '@maka/core/sandbox-boundary';

import type { SessionEvent } from '@maka/core/events';

import { createAppShellSessionEventHandlers } from '../../renderer/app-shell-session-events.js';
import {
  EXECUTION_BOUNDARY_READ_RETRY_DELAYS_MS,
  type ActiveExecutionBoundarySnapshot,
  activeExecutionBoundaryOf,
  activeExecutionBoundaryUnreadable,
  readExecutionBoundaryWithRetry,
  startActiveExecutionBoundaryRead,
} from '../../renderer/use-active-execution-boundary.js';
import { deriveDesktopExecutionBoundarySurface } from '../../renderer/desktop-execution-boundary-surface.js';

const readOnly = {
  kind: 'managed',
  profile: createReadOnlyPermissionProfile(),
  revision: 0,
} as const;
const widened = {
  kind: 'managed',
  profile: createWorkspaceWritePermissionProfile(),
  revision: 1,
} as const;

describe('Active execution boundary read model', () => {
  it('never shows one session the boundary read for another', () => {
    const snapshot = { sessionId: 'session-a', boundary: readOnly };

    assert.equal(activeExecutionBoundaryOf(snapshot, 'session-a'), readOnly);
    // Switching sessions falls closed until the new session's boundary is read,
    // rather than briefly attributing the old session's permissions to it.
    assert.equal(activeExecutionBoundaryOf(snapshot, 'session-b'), undefined);
    assert.equal(activeExecutionBoundaryOf(snapshot, undefined), undefined);
    assert.equal(activeExecutionBoundaryOf(undefined, 'session-a'), undefined);
  });

  it('a stale snapshot would misreport permissions the user just granted (#1611)', () => {
    // Why the reload below has to exist: the two boundaries differ only in
    // revision + profile, and they drive different labels.
    assert.equal(
      deriveDesktopExecutionBoundarySurface('session-a', readOnly, 'ask').permissionMode,
      'explore',
    );
    assert.equal(
      deriveDesktopExecutionBoundarySurface('session-a', widened, 'ask').permissionMode,
      'ask',
    );
  });
});

describe('A boundary read that fails (#1629)', () => {
  function retryHarness(read: () => Promise<typeof readOnly>) {
    const waits: number[] = [];
    let cancelled = false;
    return {
      waits,
      cancel: () => {
        cancelled = true;
      },
      run: () =>
        readExecutionBoundaryWithRetry({
          read,
          wait: async (delayMs) => {
            waits.push(delayMs);
          },
          cancelled: () => cancelled,
        }),
    };
  }

  it('recovers from a transient failure instead of leaving the boundary unknown', async () => {
    // The reload race this was found through: main has not settled the restored
    // session yet, so the first read rejects. One rejection used to be final.
    let attempts = 0;
    const harness = retryHarness(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('session not ready');
      return readOnly;
    });

    assert.deepEqual(await harness.run(), { outcome: 'read', boundary: readOnly });
    assert.equal(attempts, 2);
    assert.deepEqual(harness.waits, [EXECUTION_BOUNDARY_READ_RETRY_DELAYS_MS[0]]);
  });

  it('gives up after a bounded number of attempts rather than polling', async () => {
    let attempts = 0;
    const harness = retryHarness(async () => {
      attempts += 1;
      throw new Error('unreachable');
    });

    assert.deepEqual(await harness.run(), { outcome: 'unreadable' });
    // One attempt per retry delay, plus the first: a real outage converges on a
    // state the surface can explain, and never becomes an unbounded loop.
    assert.equal(attempts, EXECUTION_BOUNDARY_READ_RETRY_DELAYS_MS.length + 1);
    assert.deepEqual(harness.waits, [...EXECUTION_BOUNDARY_READ_RETRY_DELAYS_MS]);
    assert.ok(harness.waits.every((delay) => delay > 0));
  });

  it('stops retrying a session the user has already left', async () => {
    let attempts = 0;
    const harness = retryHarness(async () => {
      attempts += 1;
      throw new Error('unreachable');
    });
    harness.cancel();

    // Cancellation is not an outcome the surface reports: the session it was
    // asking about is gone, so there is nothing to tell the user about it.
    assert.deepEqual(await harness.run(), { outcome: 'cancelled' });
    assert.equal(attempts, 0);
    assert.deepEqual(harness.waits, []);
  });

  it('does not report a read that main answered after it was cancelled', async () => {
    // Cancelling before the first call is the easy half. The half that matters
    // is cancelling while main is mid-answer: the reply still arrives, and
    // without a re-check it comes back indistinguishable from a live one.
    const answer = deferred<ExecutionBoundary>();
    let cancelled = false;
    const result = readExecutionBoundaryWithRetry({
      read: () => answer.promise,
      wait: async () => {},
      cancelled: () => cancelled,
    });

    cancelled = true;
    answer.resolve(readOnly);

    assert.deepEqual(await result, { outcome: 'cancelled' });
  });

  it('separates "asked and failed" from "not asked yet", and both fail closed', () => {
    const failed = { sessionId: 'session-a', boundary: undefined };

    assert.equal(activeExecutionBoundaryUnreadable(failed, 'session-a'), true);
    // Still reading, and a result belonging to another session, are silence -
    // the surface waits rather than telling the user something is wrong.
    assert.equal(activeExecutionBoundaryUnreadable(undefined, 'session-a'), false);
    assert.equal(activeExecutionBoundaryUnreadable(failed, 'session-b'), false);
    assert.equal(activeExecutionBoundaryUnreadable(failed, undefined), false);

    // Whichever it is, the boundary stays unknown and local execution stays off:
    // #1629 is about recovering from that state, not opening it up.
    assert.equal(activeExecutionBoundaryOf(failed, 'session-a'), undefined);
    assert.deepEqual(
      deriveDesktopExecutionBoundarySurface(
        'session-a',
        activeExecutionBoundaryOf(failed, 'session-a'),
        'ask',
      ),
      { permissionMode: undefined, localInteractionAvailable: false },
    );
  });

});

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolveValue) => {
    resolve = resolveValue;
  });
  return { promise, resolve };
}

/** Let every pending microtask chain run to completion. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

function recordingCommit() {
  const snapshots: ActiveExecutionBoundarySnapshot[] = [];
  const readings: boolean[] = [];
  return {
    snapshots,
    readings,
    setReading: (reading: boolean) => {
      readings.push(reading);
    },
    setSnapshot: (snapshot: ActiveExecutionBoundarySnapshot) => {
      snapshots.push(snapshot);
    },
  };
}

describe('Only the newest boundary read may commit', () => {
  it('does not let a session the user left overwrite the one they opened', async () => {
    const answerA = deferred<ExecutionBoundary>();
    const answerB = deferred<ExecutionBoundary>();
    const commit = recordingCommit();

    const retireA = startActiveExecutionBoundaryRead({
      sessionId: 'session-a',
      read: () => answerA.promise,
      commit,
      retryDelaysMs: [],
    });
    // Switching sessions: React runs the previous cleanup before the next
    // effect body, so B's generation always starts after A's has been retired.
    retireA();
    startActiveExecutionBoundaryRead({
      sessionId: 'session-b',
      read: () => answerB.promise,
      commit,
      retryDelaysMs: [],
    });

    answerB.resolve(widened);
    await settle();
    answerA.resolve(readOnly);
    await settle();

    // A's late reply would name a session that is no longer active, which the
    // surface reads as "boundary unknown, and nothing wrong" — composer hidden,
    // no notice, and no read left in flight to recover it. That is #1629 again.
    assert.deepEqual(commit.snapshots, [{ sessionId: 'session-b', boundary: widened }]);
  });

  // The shape CI reproduced from the first cut of this fix: changing the
  // permission mode re-runs the read (permissionMode is one of its triggers),
  // and the previous generation's answer landed afterwards and put the old
  // boundary back. The composer's label then still read 只读 right after the
  // user chose 自动 — the read model's own state, not anything main said.
  it('does not let a superseded revision come back after a reload or a mode change', async () => {
    const staleAnswer = deferred<ExecutionBoundary>();
    const freshAnswer = deferred<ExecutionBoundary>();
    const commit = recordingCommit();

    const retireStale = startActiveExecutionBoundaryRead({
      sessionId: 'session-a',
      read: () => staleAnswer.promise,
      commit,
      retryDelaysMs: [],
    });
    // `reload()` after a decision settles, or the stored permission mode moving
    // under the hook: same session, new generation. The session id matches on
    // both, so only the generation can tell them apart.
    retireStale();
    startActiveExecutionBoundaryRead({
      sessionId: 'session-a',
      read: () => freshAnswer.promise,
      commit,
      retryDelaysMs: [],
    });

    freshAnswer.resolve(widened);
    await settle();
    staleAnswer.resolve(readOnly);
    await settle();

    // Otherwise the label tells the user this session cannot write, moments
    // after they granted it write access — the #1611 staleness, reintroduced
    // through the back door.
    assert.deepEqual(commit.snapshots, [{ sessionId: 'session-a', boundary: widened }]);
    // And a retired read must not report the live one as finished either.
    assert.deepEqual(commit.readings, [false]);
  });
});

describe('Boundary decisions notify the read model', () => {
  function handlersWithRecorder() {
    const boundaryChanges: string[] = [];
    const handlers = createAppShellSessionEventHandlers({
      uiLocale: 'zh',
      activeIdRef: { current: 'session-a' },
      liveTurnBySessionRef: { current: {} },
      refreshMessages: async () => true,
      refreshSessions: async () => [],
      setLiveTurnBySession: () => {},
      setInteractionBySession: () => {},
      onExecutionBoundaryChanged: (sessionId) => boundaryChanges.push(sessionId),
      showModelSetupToast: () => {},
      toastApi: { error: () => {} },
    });
    return { handlers, boundaryChanges };
  }

  it('re-reads authority when a boundary decision is acknowledged', () => {
    const { handlers, boundaryChanges } = handlersWithRecorder();

    handlers.handleEvent('session-a', {
      type: 'sandbox_boundary_decision_ack',
      id: 'event-ack',
      turnId: 'turn-1',
      ts: 1,
      requestId: 'request-1',
      toolUseId: 'tool-1',
      decision: 'allow',
      status: 'approved',
      revision: 1,
    } satisfies SessionEvent);

    // Approving an expansion moves only the boundary's revision: no session
    // field changes, so without this signal the surface would keep rendering
    // the permissions the session had before the user granted more.
    assert.deepEqual(boundaryChanges, ['session-a']);
  });

  it('does not re-read on events that cannot move a boundary', () => {
    const { handlers, boundaryChanges } = handlersWithRecorder();

    handlers.handleEvent('session-a', {
      type: 'sandbox_boundary_request',
      id: 'event-request',
      turnId: 'turn-1',
      ts: 1,
      requestId: 'request-1',
      toolUseId: 'tool-1',
      justification: 'write outside the workspace',
      expansion: {
        filesystem: { entries: [{ path: '/outside', access: 'write', scope: 'subtree' }] },
      },
    } satisfies SessionEvent);

    assert.deepEqual(boundaryChanges, []);
  });
});
