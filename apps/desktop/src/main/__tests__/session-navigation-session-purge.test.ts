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
import type { SessionSummary } from '@maka/core/session';
import {
  createSessionNavigationRowActions,
  type SessionNavigationSessionService,
} from '../../renderer/features/session-navigation/testing.js';

function summary(id: string, overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id,
    name: id,
    isFlagged: false,
    isArchived: true,
    labels: [],
    hasUnread: false,
    status: 'active',
    backend: 'fake',
    llmConnectionSlug: 'test',
    connectionLocked: true,
    model: 'test',
    permissionMode: 'ask',
    ...overrides,
  };
}

/** A task that left the archive while retaining its independent execution status. */
function restored(id: string): SessionSummary {
  return summary(id, { isArchived: false });
}

type SweepHarness = {
  removed: string[];
  /** Each `previewRemoval` call, in order. */
  previews: string[];
  /** Each `archive` call, in order. */
  archived: string[];
  /** Each `remove` call as `[sessionId, requireArchived]`. */
  removeOptions: Array<[string, boolean]>;
  cleared: string[];
  selections: Array<string | undefined>;
  /** Titles of the success toasts a row action raised. */
  toasts: string[];
  /** Their descriptions, positionally — the half that carries the counts. */
  toastDescriptions: (string | undefined)[];
  listCalls: number;
};

/**
 * Creates a Session service whose `remove` fails for the named ids and
 * whose `list` answers with `surviving` (or throws when it is `undefined`,
 * standing in for a catalog that cannot be read back).
 */
function installService(
  harness: SweepHarness,
  options: {
    rejectIds?: readonly string[];
    rejectArchiveIds?: readonly string[];
    /** Subtasks the Host says a delete would archive, per source id. */
    previewSubtasks?: Readonly<Record<string, number>>;
    /** Ids whose preview rejects, standing in for a Host that cannot answer. */
    rejectPreviewIds?: readonly string[];

    rejectWithUndefinedIds?: readonly string[];
    surviving?: readonly SessionSummary[];
    /** Runs after each accepted removal, to model what another client did meanwhile. */
    onRemove?: (sessionId: string) => void;
    /**
     * The catalog the fake Host decides against. It checks the archived premise
     * here, where the real one checks it inside its compare-and-set — not
     * against whatever the renderer last saw.
     */
    catalog?: readonly SessionSummary[];
    /** Subtasks the Host archives per removed id, summed into the outcome. */
    archivedByRemoval?: Record<string, number>;
  } = {},
): SessionNavigationSessionService {
  return {
    list: async () => {
      harness.listCalls += 1;
      if (!options.surviving) throw new Error('catalog unavailable');
      return [...options.surviving];
    },
    setFlagged: async () => undefined,
    archive: async (id) => {
      harness.archived.push(id);
      if (options.rejectArchiveIds?.includes(id)) throw new Error(`archive-busy:${id}`);
    },
    unarchive: async () => undefined,
    rename: async () => undefined,
    remove: async (id, removeOptions) => {
      harness.removeOptions.push([id, removeOptions.requireArchived]);
      if (options.rejectWithUndefinedIds?.includes(id)) {
        return Promise.reject(undefined);
      }
      if (options.rejectIds?.includes(id)) throw new Error(`busy:${id}`);
      const target = options.catalog?.find((session) => session.id === id);
      if (removeOptions.requireArchived && target && !target.isArchived) {
        return { disposition: 'restored', archivedSubtaskCount: 0 };
      }
      harness.removed.push(id);
      options.onRemove?.(id);
      return { disposition: 'removed', archivedSubtaskCount: options.archivedByRemoval?.[id] ?? 0 };
    },
    previewRemoval: async (id: string) => {
      harness.previews.push(id);
      if (options.rejectPreviewIds?.includes(id)) throw new Error(`preview-unavailable:${id}`);
      return options.previewSubtasks?.[id] ?? 0;
    },
  };
}

function createActions(input: {
  harness: SweepHarness;
  sessions: SessionSummary[];
  activeIdRef: { current: string | undefined };
  pending?: Set<string>;
  refreshed?: SessionSummary[];
  service: SessionNavigationSessionService;
  /** Answers the confirm and records what it was asked, for the sweeps. */
  onConfirm?: (options: { title: string; description: string }) => boolean;
}) {
  return createSessionNavigationRowActions({
    uiLocale: 'en',
    activeIdRef: input.activeIdRef,
    clearActiveMessages: () => undefined,
    clearSessionRendererState: (id) => {
      input.harness.cleared.push(id);
    },
    pendingSessionRowActionsRef: { current: input.pending ?? new Set<string>() },
    refreshSessions: async () => input.refreshed ?? [],
    service: input.service,
    sessionsRef: { current: input.sessions },
    setActiveId: (id) => {
      input.harness.selections.push(id);
      input.activeIdRef.current = id;
    },
    toastApi: {
      success: (title: string, description?: string) => {
        input.harness.toasts.push(title);
        input.harness.toastDescriptions.push(description);
      },
      error: () => undefined,
      confirm: async (options) => input.onConfirm?.(options) ?? true,
    },
  });
}

function harness(): SweepHarness {
  return {
    removed: [],
    previews: [],
    archived: [],
    removeOptions: [],
    cleared: [],
    selections: [],
    toasts: [],
    toastDescriptions: [],
    listCalls: 0,
  };
}

describe('purgeSessions', () => {
  it('deletes the whole set, clears each family, and does not read the catalog back', async () => {
    const h = harness();
    const sessions = [
      summary('a'),
      summary('a-v2', { revisionRootSessionId: 'a', revisionParentSessionId: 'a' }),
      summary('b'),
    ];
    const activeIdRef = { current: 'a-v2' as string | undefined };
    const service = installService(h);
    const actions = createActions({ harness: h, sessions, activeIdRef, service });

    const outcome = await actions.purgeSessions(['a-v2', 'b']);

    assert.deepEqual(h.removed, ['a-v2', 'b']);
    assert.deepEqual(outcome, {
      removed: 2,
      archivedSubtasks: 0,
      remaining: [],
      restored: [],
      verified: true,
      firstFailure: undefined,
    });
    // Every delete in a sweep carries the archived premise the confirm named.
    assert.deepEqual(h.removeOptions, [
      ['a-v2', true],
      ['b', true],
    ]);
    // The family goes, not just the representative, and the open member of it
    // stops being the active session.
    assert.deepEqual(h.cleared.sort(), ['a', 'a-v2', 'b']);
    assert.deepEqual(h.selections, [undefined]);
    // Nothing rejected, so there is nothing to check back.
    assert.equal(h.listCalls, 0);
  });

  it('sums the linked subtasks the Host archived across the sweep', async () => {
    const h = harness();
    const sessions = [summary('p1'), summary('p2'), summary('p3')];
    const activeIdRef = { current: undefined as string | undefined };
    // p1 archives 2 subtasks, p3 archives 1; p2 archives none.
    const service = installService(h, { archivedByRemoval: { p1: 2, p3: 1 } });
    const actions = createActions({ harness: h, sessions, activeIdRef, service });

    const outcome = await actions.purgeSessions(['p1', 'p2', 'p3']);

    assert.equal(outcome.removed, 3);
    assert.equal(outcome.archivedSubtasks, 3);
  });

  it('reports a task restored before the sweep reached it, rather than dropping it', async () => {
    // The confirm named a set. One restored from another surface while the
    // dialog was up has left it, and a sweep that deleted it anyway would be
    // acting outside what was agreed to. Reporting it is the other half: the
    // person agreed to two and one went, which needs saying.
    const h = harness();
    const catalog = [restored('kept'), summary('doomed')];
    const service = installService(h, { catalog });
    const actions = createActions({
      harness: h,
      sessions: [...catalog],
      activeIdRef: { current: undefined },
      service,
    });

    const outcome = await actions.purgeSessions(['kept', 'doomed']);

    assert.deepEqual(h.removed, ['doomed']);
    assert.equal(outcome.removed, 1);
    assert.deepEqual(outcome.restored, ['kept']);
    assert.deepEqual(outcome.remaining, []);
    // Kept tasks are settled by the delete itself; nothing to check back.
    assert.equal(h.listCalls, 0);
  });

  it('reports a task restored while the sweep was already running', async () => {
    // The page disables its own controls during a sweep, so the restore comes
    // from a second window, landing after the sweep started and before it
    // reached this task.
    const h = harness();
    const catalog = [summary('first'), summary('second')];
    const service = installService(h, {
      catalog,
      onRemove: (id) => {
        if (id === 'first') catalog[1] = restored('second');
      },
    });
    const actions = createActions({
      harness: h,
      sessions: [...catalog],
      activeIdRef: { current: undefined },
      service,
    });

    const outcome = await actions.purgeSessions(['first', 'second']);

    assert.deepEqual(h.removed, ['first']);
    assert.equal(outcome.removed, 1);
    assert.deepEqual(outcome.restored, ['second']);
    assert.deepEqual(outcome.remaining, []);
  });

  it('keeps everything the renderer holds for a task the delete left alone', async () => {
    const h = harness();
    const catalog = [summary('first'), restored('rescued')];
    const service = installService(h, { catalog });
    const activeIdRef = { current: 'rescued' as string | undefined };
    const actions = createActions({ harness: h, sessions: [...catalog], activeIdRef, service });

    const outcome = await actions.purgeSessions(['first', 'rescued']);

    assert.deepEqual(outcome.restored, ['rescued']);
    assert.equal(outcome.firstFailure, undefined);
    // A task that is still there keeps its renderer state, including being the
    // open one.
    assert.deepEqual(h.cleared, ['first']);
    assert.deepEqual(h.selections, []);
    assert.equal(activeIdRef.current, 'rescued');
  });

  it('sends every id to the delete instead of deciding against its own snapshot', async () => {
    // The renderer's list is one observer of a state the Host owns, and a
    // serial sweep gives a second window plenty of room to outdate it — in
    // either direction. Here the snapshot is stale in the direction that
    // silently spares a task: it reads `stale` as no longer archived while the
    // catalog the delete commits against still has it archived. Filtering here
    // would drop the id with no outcome at all, which is how a confirmed count
    // stops adding up.
    const h = harness();
    const service = installService(h, { catalog: [summary('stale'), summary('plain')] });
    const actions = createActions({
      harness: h,
      sessions: [restored('stale'), summary('plain')],
      activeIdRef: { current: undefined },
      service,
    });

    const outcome = await actions.purgeSessions(['stale', 'plain']);

    assert.deepEqual(h.removeOptions, [
      ['stale', true],
      ['plain', true],
    ]);
    assert.deepEqual(h.removed, ['stale', 'plain']);
    assert.equal(outcome.removed, 2);
    assert.deepEqual(outcome.restored, []);
  });

  it('skips an id whose row action is already in flight instead of racing it', async () => {
    const h = harness();
    const sessions = [summary('busy'), summary('free')];
    const service = installService(h, { surviving: [summary('busy')] });
    const actions = createActions({
      harness: h,
      sessions,
      activeIdRef: { current: undefined },
      pending: new Set(['busy:delete']),
      service,
    });

    const outcome = await actions.purgeSessions(['busy', 'free']);

    assert.deepEqual(h.removed, ['free']);
    assert.deepEqual(outcome.remaining, ['busy']);
    assert.equal(outcome.removed, 1);
  });

  it('counts a rejected delete that the catalog no longer lists as removed', async () => {
    // The delete IPC commits the removal before it releases renderer
    // resources, so a rejection is not evidence the task survived. Only the
    // catalog can settle it.
    const h = harness();
    const sessions = [summary('committed'), summary('survivor')];
    const service = installService(h, {
      rejectIds: ['committed', 'survivor'],
      surviving: [summary('survivor')],
    });
    const actions = createActions({ harness: h, sessions, activeIdRef: { current: undefined }, service });

    const outcome = await actions.purgeSessions(['committed', 'survivor']);

    assert.equal(h.listCalls, 1);
    assert.deepEqual(outcome.remaining, ['survivor']);
    assert.equal(outcome.removed, 1);
    assert.ok(outcome.firstFailure);
    assert.equal((outcome.firstFailure.error as Error).message, 'busy:committed');
    assert.equal(outcome.firstFailure.sessionId, 'committed');
  });

  it('retains the first failing Session even when the rejection value is undefined', async () => {
    const h = harness();
    const sessions = [summary('first'), summary('second')];
    const service = installService(h, {
      rejectWithUndefinedIds: ['first'],
      rejectIds: ['second'],
      surviving: sessions,
    });
    const actions = createActions({ harness: h, sessions, activeIdRef: { current: undefined }, service });

    const outcome = await actions.purgeSessions(['first', 'second']);

    assert.ok(outcome.firstFailure);
    assert.equal(outcome.firstFailure.sessionId, 'first');
    assert.equal(outcome.firstFailure.error, undefined);
  });

  it('claims nothing when the catalog cannot be read back', async () => {
    // `refreshSessions` would have answered with the pre-delete list here, and
    // reporting on that would have called a completed sweep a total failure.
    const h = harness();
    const sessions = [summary('a')];
    const service = installService(h, { rejectIds: ['a'], surviving: undefined });
    const actions = createActions({
      harness: h,
      sessions,
      activeIdRef: { current: undefined },
      refreshed: sessions,
      service,
    });

    const outcome = await actions.purgeSessions(['a']);

    assert.equal(outcome.verified, false);
    assert.deepEqual(outcome.remaining, []);
    assert.equal(outcome.removed, 0);
  });
});

describe('deleteSession', () => {
  it('carries the archived premise of the row the confirm named', async () => {
    // Deleting from 已归档任务 is the same decision a sweep makes, one row at a
    // time, so a restore revokes it the same way.
    const h = harness();
    const sessions = [summary('archived-row'), restored('active-row')];
    const service = installService(h);
    const actions = createActions({ harness: h, sessions, activeIdRef: { current: undefined }, service });

    await actions.deleteSession('archived-row');
    await actions.deleteSession('active-row');

    // An active task never had an archived premise to lose, so requiring one
    // would refuse every delete from the rail.
    assert.deepEqual(h.removeOptions, [
      ['archived-row', true],
      ['active-row', false],
    ]);
  });

  it('keeps a task the Host reports as restored, and says so', async () => {
    const h = harness();
    // The row was archived when the confirm named it; the catalog the delete
    // commits against says otherwise by the time it lands.
    const sessions = [summary('rescued')];
    const service = installService(h, { catalog: [restored('rescued')] });
    const activeIdRef = { current: 'rescued' as string | undefined };
    const actions = createActions({ harness: h, sessions, activeIdRef, service });

    await actions.deleteSession('rescued');

    assert.deepEqual(h.removed, []);
    assert.deepEqual(h.cleared, []);
    assert.equal(activeIdRef.current, 'rescued');
    // Not "Deleted rescued": nothing was.
    assert.deepEqual(h.toasts, ['rescued was restored, so it was kept']);
  });
});

describe('deleteSessions', () => {
  it('reads the archived premise per task instead of asserting it', async () => {
    const h = harness();
    // The rail lists unarchived tasks. Asserting the archived premise for them
    // — which is what the Settings purge does — would make the Host refuse
    // every deletion the rail can ask for.
    const sessions = [summary('live', { isArchived: false }), summary('filed')];
    const activeIdRef = { current: undefined as string | undefined };
    const service = installService(h, { catalog: sessions });
    const actions = createActions({ harness: h, sessions, activeIdRef, service });

    const outcome = await actions.deleteSessions(['live', 'filed']);

    assert.deepEqual(h.removed, ['live', 'filed']);
    assert.deepEqual(h.removeOptions, [
      ['live', false],
      ['filed', true],
    ]);
    assert.equal(outcome.removed, 2);
    assert.deepEqual(outcome.remaining, []);
    assert.equal(outcome.verified, true);
  });

  it('accounts for a rejection against the catalog, exactly as the purge does', async () => {
    const h = harness();
    const sessions = [summary('a', { isArchived: false }), summary('b', { isArchived: false })];
    const activeIdRef = { current: undefined as string | undefined };
    // 'b' rejects but is gone from the catalog anyway: the delete IPC commits
    // the removal before it releases renderer resources, so a rejection is not
    // evidence the task survived.
    const service = installService(h, { rejectIds: ['b'], surviving: [] });
    const actions = createActions({ harness: h, sessions, activeIdRef, service });

    const outcome = await actions.deleteSessions(['a', 'b']);

    assert.equal(outcome.removed, 2);
    assert.deepEqual(outcome.remaining, []);
    assert.equal(outcome.verified, true);
    assert.ok(outcome.firstFailure);
    assert.equal((outcome.firstFailure.error as Error).message, 'busy:b');
  });

  it('claims nothing when the catalog cannot be read back', async () => {
    const h = harness();
    const sessions = [summary('a', { isArchived: false })];
    const activeIdRef = { current: undefined as string | undefined };
    const service = installService(h, { rejectIds: ['a'] });
    const actions = createActions({ harness: h, sessions, activeIdRef, service });

    const outcome = await actions.deleteSessions(['a']);

    assert.equal(outcome.verified, false);
    assert.equal(outcome.removed, 0);
    assert.deepEqual(outcome.remaining, []);
  });
});

describe('archiveSessions', () => {
  it('archives the set, clears each family, and refreshes once', async () => {
    const h = harness();
    const sessions = [
      summary('a', { isArchived: false }),
      summary('a-v2', {
        isArchived: false,
        revisionRootSessionId: 'a',
        revisionParentSessionId: 'a',
      }),
      summary('b', { isArchived: false }),
    ];
    const activeIdRef = { current: 'a-v2' as string | undefined };
    let refreshes = 0;
    const actions = createSessionNavigationRowActions({
      uiLocale: 'en',
      activeIdRef,
      clearActiveMessages: () => undefined,
      clearSessionRendererState: (id) => {
        h.cleared.push(id);
      },
      pendingSessionRowActionsRef: { current: new Set<string>() },
      refreshSessions: async () => {
        refreshes += 1;
        return [];
      },
      service: installService(h),
      sessionsRef: { current: sessions },
      setActiveId: (id) => {
        h.selections.push(id);
        activeIdRef.current = id;
      },
      toastApi: {
        success: (title: string) => {
          h.toasts.push(title);
        },
        error: () => undefined,
        confirm: async () => true,
      },
    });

    const outcome = await actions.archiveSessions(['a-v2', 'b']);

    assert.deepEqual(h.archived, ['a-v2', 'b']);
    assert.deepEqual(outcome, { archived: 2, failed: [], firstFailure: undefined });
    // The whole revision family leaves the rail, so the renderer drops all of
    // it — and the active task went with it.
    assert.deepEqual(h.cleared, ['a', 'a-v2', 'b']);
    assert.deepEqual(h.selections, [undefined]);
    // Once for the sweep, not once per task: a refresh per id re-renders the
    // rail under the cursor for every row in the selection.
    assert.equal(refreshes, 1);
  });

  it('keeps going past a failure and names the first one', async () => {
    const h = harness();
    const sessions = ['a', 'b', 'c'].map((id) => summary(id, { isArchived: false }));
    const activeIdRef = { current: undefined as string | undefined };
    const service = installService(h, { rejectArchiveIds: ['b'] });
    const actions = createActions({ harness: h, sessions, activeIdRef, service });

    const outcome = await actions.archiveSessions(['a', 'b', 'c']);

    // 'c' is still attempted: one Host refusing is not the sweep's answer for
    // every task in it.
    assert.deepEqual(h.archived, ['a', 'b', 'c']);
    assert.equal(outcome.archived, 2);
    assert.deepEqual(outcome.failed, ['b']);
    assert.ok(outcome.firstFailure);
    assert.equal((outcome.firstFailure.error as Error).message, 'archive-busy:b');
    assert.equal(outcome.firstFailure?.sessionId, 'b');
    // No per-task toast: the caller phrases one message for the sweep.
    assert.deepEqual(h.toasts, []);
  });

  it('skips a task whose row action is already in flight', async () => {
    const h = harness();
    const sessions = [summary('a', { isArchived: false }), summary('b', { isArchived: false })];
    const activeIdRef = { current: undefined as string | undefined };
    const service = installService(h);
    const actions = createActions({
      harness: h,
      sessions,
      activeIdRef,
      pending: new Set(['a:rename']),
      service,
    });

    const outcome = await actions.archiveSessions(['a', 'b']);

    assert.deepEqual(h.archived, ['b']);
    // Reported rather than silently dropped: the count the caller shows has to
    // add up to the number of tasks the user selected.
    assert.deepEqual(outcome.failed, ['a']);
    assert.equal(outcome.archived, 1);
  });
});

describe('deleteSelected', () => {
  it('warns that linked subtasks will be archived, and reports what was', async () => {
    // The Host archives a deleted parent's ordinary subagent tasks rather than
    // deleting them. Without the warning they reappear under Archived with no
    // explanation; without the report the user never learns how many did.
    const h = harness();
    const sessions = ['a', 'b'].map((id) => summary(id, { isArchived: false }));
    const activeIdRef = { current: undefined as string | undefined };
    const service = installService(h, {
      previewSubtasks: { a: 2 },
      archivedByRemoval: { a: 2, b: 1 },
    });
    const confirms: Array<{ description: string }> = [];
    const actions = createActions({
      harness: h,
      sessions,
      activeIdRef,
      service,
      onConfirm: (options) => {
        confirms.push({ description: options.description });
        return true;
      },
    });

    await actions.deleteSelected(['a', 'b']);

    // One preview per selected task: the renderer's projection cannot answer
    // this, so it is asked for every id the confirm is about to name.
    assert.deepEqual(h.previews, ['a', 'b']);
    assert.equal(confirms.length, 1);
    assert.match(confirms[0]!.description, /moved to Archived/);
    assert.deepEqual(h.toasts, ['Deleted 2 tasks']);
    assert.deepEqual(h.toastDescriptions, ['3 subtasks moved to Archived']);
  });

  it('says the subtask warning is uncertain when one preview cannot be read', async () => {
    // Under-reporting a destructive set is worse than admitting the number is
    // unknown: a silent zero reads as "nothing else will move".
    const h = harness();
    const sessions = ['a', 'b'].map((id) => summary(id, { isArchived: false }));
    const activeIdRef = { current: undefined as string | undefined };
    const service = installService(h, {
      previewSubtasks: { a: 2 },
      rejectPreviewIds: ['b'],
    });
    const confirms: string[] = [];
    const actions = createActions({
      harness: h,
      sessions,
      activeIdRef,
      service,
      onConfirm: (options) => {
        confirms.push(options.description);
        return true;
      },
    });

    await actions.deleteSelected(['a', 'b']);

    assert.equal(confirms.length, 1);
    assert.match(confirms[0]!, /Any ordinary subtasks/);
  });

  it('says nothing about subtasks when the selection has none', async () => {
    const h = harness();
    const sessions = [summary('a', { isArchived: false })];
    const activeIdRef = { current: undefined as string | undefined };
    const service = installService(h);
    const confirms: string[] = [];
    const actions = createActions({
      harness: h,
      sessions,
      activeIdRef,
      service,
      onConfirm: (options) => {
        confirms.push(options.description);
        return true;
      },
    });

    await actions.deleteSelected(['a']);

    assert.doesNotMatch(confirms[0]!, /Archived/);
    assert.deepEqual(h.toastDescriptions, [undefined]);
  });

  it('does nothing when the confirm is declined', async () => {
    const h = harness();
    const sessions = [summary('a', { isArchived: false })];
    const activeIdRef = { current: undefined as string | undefined };
    const service = installService(h);
    const actions = createActions({
      harness: h,
      sessions,
      activeIdRef,
      service,
      onConfirm: () => false,
    });

    await actions.deleteSelected(['a']);

    assert.deepEqual(h.removed, []);
    assert.deepEqual(h.toasts, []);
  });
});
