import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createReadOnlyPermissionProfile, createWorkspaceWritePermissionProfile } from '@maka/core';
import type { SessionEvent } from '@maka/core';

import { createAppShellSessionEventHandlers } from '../../renderer/app-shell-session-events.js';
import {
  EXECUTION_BOUNDARY_READ_RETRY_DELAYS_MS,
  activeExecutionBoundaryOf,
  activeExecutionBoundaryUnreadable,
  readExecutionBoundaryWithRetry,
} from '../../renderer/use-active-execution-boundary.js';
import { deriveDesktopExecutionBoundarySurface } from '../../renderer/desktop-execution-boundary-surface.js';
import { readRendererShellSource } from './renderer-shell-source-helpers.js';

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

  it('turns the unreadable state into something on screen, with a way back', async () => {
    const shell = await readRendererShellSource('app-shell.tsx');
    const composerRegion = await readRendererShellSource('chat-composer-region.tsx');

    // Only once the read has given up - a read still in flight has nothing to
    // report - and never over the onboarding surface, which owns the composer.
    assert.match(
      shell,
      /activeId && activeExecutionBoundaryUnreadable && !onboardingComposerHidden/,
    );
    assert.match(shell, /onRetry: \(\) => reloadActiveExecutionBoundary\(activeId\)/);
    assert.match(shell, /boundaryUnreadableNotice=\{boundaryUnreadableNotice\}/);
    // The notice is the only thing standing between the user and a window with
    // no input in it, so it must carry both the reason and the retry.
    assert.match(composerRegion, /boundaryUnreadableNotice\.title/);
    assert.match(composerRegion, /boundaryUnreadableNotice\.detail/);
    assert.match(composerRegion, /onClick=\{boundaryUnreadableNotice\.onRetry\}/);
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
