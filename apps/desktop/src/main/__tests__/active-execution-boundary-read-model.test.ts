/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import { deferred } from '@maka/core/test-only/async-primitives';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createReadOnlyPermissionProfile, createWorkspaceWritePermissionProfile } from '@maka/core/permission-profile';
import type { ExecutionBoundary } from '@maka/core/sandbox-boundary';

import type { SessionEvent } from '@maka/core/events';

import { parseHTML } from 'linkedom';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { createAppShellSessionEventHandlers } from '../../renderer/app-shell-session-events.js';
import {
  ConversationServicesProvider,
  type ConversationHostChange,
  type ConversationServices,
  useActiveExecutionBoundary,
} from '../../renderer/features/conversation/index.js';
import {
  type ActiveExecutionBoundarySnapshot,
  activeExecutionBoundaryOf,
  activeExecutionBoundaryUnreadable,
  startActiveExecutionBoundaryRead,
} from '../../renderer/features/conversation/testing.js';
import { desktopSessionKey } from '../../shared/runtime-host-identity.js';
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

  it('shows a pending mode change only once the boundary is known', () => {
    assert.deepEqual(
      deriveDesktopExecutionBoundarySurface('session-a', widened, 'ask', 'bypass'),
      { permissionMode: 'bypass', localInteractionAvailable: true },
    );
    assert.deepEqual(
      deriveDesktopExecutionBoundarySurface('session-a', undefined, 'ask', 'bypass'),
      { permissionMode: undefined, localInteractionAvailable: false },
    );
  });
});

describe('A boundary read that fails (#1629)', () => {
  it('settles as unreadable instead of leaving the read pending forever', async () => {
    const commit = recordingCommit();
    startActiveExecutionBoundaryRead({
      sessionId: 'session-a',
      read: async () => {
        throw new Error('unreachable');
      },
      commit,
    });
    await settle();

    assert.deepEqual(commit.snapshots, [{ sessionId: 'session-a', boundary: undefined }]);
    assert.deepEqual(commit.readings, [false]);
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

  it('recovers an unreadable boundary when the session Host reports ready', async () => {
    const harness = await renderActiveBoundary([Promise.reject(new Error('generation replaced'))]);
    try {
      assert.equal(harness.latest()?.unreadable, true);

      await harness.emit({ hostId: 'host-a', readiness: 'connecting' });
      await harness.emit({ hostId: 'host-b', readiness: 'ready' });
      assert.equal(harness.readCount(), 1);

      await harness.emit({ hostId: 'host-a', readiness: 'ready' });
      assert.equal(harness.readCount(), 2);
      assert.equal(harness.latest()?.unreadable, false);
      assert.equal(harness.latest()?.boundary, readOnly);
    } finally {
      await harness.unmount();
    }
  });

  it('recovers when the ready push arrives before the failing read settles', async () => {
    const replaced = deferred<ExecutionBoundary>();
    const harness = await renderActiveBoundary([replaced.promise]);
    try {
      await harness.emit({ hostId: 'host-a', readiness: 'ready' });
      await act(async () => replaced.reject(new Error('generation replaced')));

      assert.equal(harness.readCount(), 2);
      assert.equal(harness.latest()?.unreadable, false);
      assert.equal(harness.latest()?.boundary, readOnly);
    } finally {
      await harness.unmount();
    }
  });
});
/**
 * Render `useActiveExecutionBoundary` for a session on `host-a`. Reads answer
 * from `reads` in order, then with `readOnly`.
 */
async function renderActiveBoundary(reads: Array<Promise<ExecutionBoundary>>) {
  const { document, window } = parseHTML('<div id="root"></div>');
  const originalGlobals = {
    document: globalThis.document,
    window: globalThis.window,
    IS_REACT_ACT_ENVIRONMENT: (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
      .IS_REACT_ACT_ENVIRONMENT,
  };
  Object.assign(globalThis, { document, window, IS_REACT_ACT_ENVIRONMENT: true });
  const handlers = new Set<(event: ConversationHostChange) => void>();
  let readCount = 0;
  const services = {
    sessions: {
      readExecutionBoundary: () => reads[readCount++] ?? Promise.resolve(readOnly),
    },
    runtimeHosts: {
      subscribeChanges: (handler: (event: ConversationHostChange) => void) => {
        handlers.add(handler);
        return () => handlers.delete(handler);
      },
    },
  } as unknown as ConversationServices;
  let latest: ReturnType<typeof useActiveExecutionBoundary> | undefined;
  function Probe() {
    latest = useActiveExecutionBoundary(
      desktopSessionKey({ hostId: 'host-a', sessionId: 'session-a' }),
      'ask',
    );
    return null;
  }
  const container = document.querySelector('#root');
  assert.ok(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(createElement(ConversationServicesProvider, {
      services,
      children: createElement(Probe),
    }));
  });
  return {
    latest: () => latest,
    readCount: () => readCount,
    emit: (event: ConversationHostChange) =>
      act(async () => {
        for (const handler of handlers) handler(event);
      }),
    unmount: async () => {
      await act(() => root.unmount());
      Object.assign(globalThis, originalGlobals);
    },
  };
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
    });
    // Switching sessions: React runs the previous cleanup before the next
    // effect body, so B's generation always starts after A's has been retired.
    retireA();
    startActiveExecutionBoundaryRead({
      sessionId: 'session-b',
      read: () => answerB.promise,
      commit,
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
    });
    // `reload()` after a decision settles, or the stored permission mode moving
    // under the hook: same session, new generation. The session id matches on
    // both, so only the generation can tell them apart.
    retireStale();
    startActiveExecutionBoundaryRead({
      sessionId: 'session-a',
      read: () => freshAnswer.promise,
      commit,
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
      uiLocale: 'zh-CN',
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
