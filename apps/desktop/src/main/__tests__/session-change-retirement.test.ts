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

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import type { SessionChangedEvent, SessionSummary, StoredMessage } from '@maka/core/session';
import type { TransientUserMessageProjection } from '@maka/ui';
import { handleSessionChangedEvent } from '../../renderer/application/contracts/session-catalog/session-change-effects.js';
import { createSessionCatalogController } from '../../renderer/application/contracts/session-catalog/session-catalog-state.js';
import {
  annotateWatchedRows,
  catalogWatchedRowsUsable,
  selectWatchedCatalogRows,
  type DesktopSessionSummary,
} from '../../renderer/application/contracts/session-catalog/catalog-row-watch.js';
import { createSessionWorkspaceActions } from '../../renderer/session-workspace-actions.js';
import type { DesktopTranscriptRangeController } from '../../renderer/platform/desktop/desktop-transcript-range-store.js';

function row(id: string): DesktopSessionSummary {
  return { id, name: id, activityAt: 1, isArchived: false, revision: 1 } as DesktopSessionSummary;
}

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function harness(
  activeId: string | undefined,
  catalogRows: DesktopSessionSummary[],
  source: Record<string, DesktopSessionSummary | null>,
) {
  const catalog = createSessionCatalogController();
  catalog.commitSessions(catalogRows);
  const sessionsRef = {
    get current() {
      return [...catalog.getState().sessions] as SessionSummary[];
    },
  };
  const activeIdRef = { current: activeId };
  const requestedRef = { current: activeId };
  const retired: string[] = [];
  const workspace = createSessionWorkspaceActions({
    activeIdRef,
    readRequestedSessionId: () => requestedRef.current,
    isReadableSession: () => true,
    messagesRef: { current: [] as StoredMessage[] },
    transientMessagesBySessionRef: { current: new Map<string, Map<string, TransientUserMessageProjection>>() },
    transcriptRangeRef: { current: undefined as DesktopTranscriptRangeController | undefined },
    selectionRevisionRef: { current: 0 },
    setActiveIdState: (next) => {
      activeIdRef.current = next;
      requestedRef.current = next;
    },
    setMessagesState: () => {},
    setTransientMessagesState: () => {},
    setMessageLoadPending: () => {},
    clearSessionUiState: () => {},
  });
  const options = {
    uiLocale: 'en' as const,
    activeIdRef,
    sessionsRef,
    retireSession: (sessionId: string) => retired.push(sessionId),
    retiredSessionIds: workspace.retiredSessionIds,
    isSessionRemoved: catalog.isRemoved,
    clearPendingTurnActionsForSession: () => {},
    refreshMessages: () => Promise.resolve(true),
    refreshProjects: () => Promise.resolve(),
    refreshSessions: () => {
      const next = Object.values(source).filter((s): s is DesktopSessionSummary => s !== null);
      catalog.commitSessions(next);
      return Promise.resolve(next as SessionSummary[]);
    },
    // Mirrors the production drain: the committed catalog is updated before the
    // row read resolves, so a resolved promise means sessionsRef is current.
    refreshChangedSession: (sessionId: string) => {
      const next = source[sessionId] ?? null;
      catalog.commitPatch(sessionId, next);
      return Promise.resolve(next);
    },
    setSessionEventHealthBySession: () => {},
    notifyModelRebound: () => {},
    toastApi: {
      error: () => {},
      info: () => {},
      toast: () => {},
    },
  };
  return { options, retired, sessionsRef, catalog };
}

describe('session retirement sweep', () => {
  it('keeps the selected session when an unrelated row changes', async () => {
    const { options, retired } = harness(
      'viewer',
      [row('viewer'), row('background')],
      { background: row('background') },
    );
    const event: SessionChangedEvent = {
      reason: 'message-appended',
      sessionId: 'background',
      ts: 1,
    };
    handleSessionChangedEvent(event, options);
    await flush();
    assert.deepEqual(retired, []);
  });

  it('keeps a selected session an unrelated row read cannot prove absent', async () => {
    // The pending Session is selected before its row lands in the catalog; a
    // targeted read proves only its own row, so the admission gap must not
    // read as deletion.
    const { options, retired } = harness('pending-task', [], {
      background: row('background'),
    });
    handleSessionChangedEvent(
      { reason: 'updated', sessionId: 'background', ts: 1 },
      options,
    );
    await flush();
    assert.deepEqual(retired, []);
  });

  it('retires the selected session when its row leaves the catalog', async () => {
    const { options, retired } = harness('viewer', [row('viewer'), row('background')], {
      viewer: null,
      background: row('background'),
    });
    handleSessionChangedEvent(
      { reason: 'deleted', sessionId: 'viewer', ts: 1 },
      options,
    );
    await flush();
    assert.deepEqual(retired, ['viewer']);
  });

  it('keeps the selected session when its row read fails', async () => {
    const { options, retired } = harness(
      'viewer',
      [row('viewer'), row('background')],
      {},
    );
    options.refreshChangedSession = () => Promise.resolve(null);
    handleSessionChangedEvent(
      { reason: 'status-change', sessionId: 'viewer', ts: 1 },
      options,
    );
    await flush();
    assert.deepEqual(retired, []);
  });

  it('sweeps retired rows after a membership refresh', async () => {
    const { options, retired } = harness(
      'viewer',
      [row('viewer'), row('background')],
      { background: row('background') },
    );
    handleSessionChangedEvent({ reason: 'status-change', ts: 1 }, options);
    await flush();
    assert.deepEqual(retired, ['viewer']);
  });
});

describe('revision-draft row watch fence', () => {
  const sessionRow = (id: string): DesktopSessionSummary =>
    ({ id, activityAt: 1, isArchived: false, revision: 1 }) as DesktopSessionSummary;
  const emit = (
    catalog: ReturnType<typeof createSessionCatalogController>,
    ids: readonly (string | undefined)[],
    seen: Set<string>,
  ) => annotateWatchedRows(selectWatchedCatalogRows(catalog.getState(), ids), ids, seen);

  it('fences retirement while a just-created owner is still unobserved', () => {
    const catalog = createSessionCatalogController();
    catalog.commitSessions([sessionRow('a')]);
    const seen = new Set<string>();
    const ids = ['a', 'b'] as const;
    // The draft's owner flips to B while the created-row read is in flight:
    // the catalog holds [A] and B is absent, but that absence is pending.
    const rows = emit(catalog, ids, seen);
    assert.equal(rows[1]?.pending, true);
    assert.equal(catalogWatchedRowsUsable(rows), true);
  });

  it('still retires a never-admitted row a targeted read reported gone', () => {
    const catalog = createSessionCatalogController();
    catalog.commitSessions([sessionRow('a')]);
    catalog.commitPatch('b', null);
    const rows = emit(catalog, ['a', 'b'], new Set());
    assert.equal(rows[1]?.pending, false);
    assert.equal(catalogWatchedRowsUsable(rows), false);
  });

  it('keeps a patch-admitted row when a list observed before admission lands', () => {
    const catalog = createSessionCatalogController();
    catalog.commitSessions([sessionRow('a')]);
    const observedBeforePatch = catalog.getState().revision;
    catalog.commitPatch('b', sessionRow('b'));
    catalog.commitSessions([sessionRow('a')], { observedAtRevision: observedBeforePatch });
    const rows = emit(catalog, ['a', 'b'], new Set());
    assert.equal(rows[1]?.summary?.id, 'b');
    assert.equal(catalogWatchedRowsUsable(rows), true);
  });

  it('retires the draft owner once an authoritative list omits it', () => {
    const catalog = createSessionCatalogController();
    catalog.commitSessions([sessionRow('a')]);
    catalog.commitPatch('b', sessionRow('b'));
    const seen = new Set<string>();
    const ids = ['a', 'b'] as const;
    emit(catalog, ids, seen);
    catalog.commitSessions([sessionRow('a')], {
      observedAtRevision: catalog.getState().revision,
    });
    const rows = emit(catalog, ids, seen);
    assert.equal(rows[1]?.pending, false);
    assert.equal(catalogWatchedRowsUsable(rows), false);
  });
});
