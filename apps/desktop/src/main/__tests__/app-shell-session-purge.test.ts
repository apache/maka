import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import type { SessionSummary } from '@maka/core/session';
import { createAppShellSessionRowActions } from '../../renderer/app-shell-session-row-actions.js';

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
  /** Each `remove` call as `[sessionId, requireArchived]`. */
  removeOptions: Array<[string, boolean]>;
  cleared: string[];
  selections: Array<string | undefined>;
  /** Titles of the success toasts a row action raised. */
  toasts: string[];
  listCalls: number;
};

/**
 * Installs a `window.maka.sessions` whose `remove` fails for the named ids and
 * whose `list` answers with `surviving` (or throws when it is `undefined`,
 * standing in for a catalog that cannot be read back).
 */
function installWindow(
  harness: SweepHarness,
  options: {
    rejectIds?: readonly string[];
    surviving?: readonly SessionSummary[];
    /** Runs after each accepted removal, to model what another client did meanwhile. */
    onRemove?: (sessionId: string) => void;
    /**
     * The catalog the fake Host decides against. It checks the archived premise
     * here, where the real one checks it inside its compare-and-set — not
     * against whatever the renderer last saw.
     */
    catalog?: readonly SessionSummary[];
  } = {},
): () => void {
  const target = globalThis as unknown as { window?: unknown };
  const previous = target.window;
  Object.defineProperty(target, 'window', {
    configurable: true,
    writable: true,
    value: {
      maka: {
        sessions: {
          remove: async (id: string, removeOptions?: { requireArchived?: boolean }) => {
            harness.removeOptions.push([id, removeOptions?.requireArchived === true]);
            if (options.rejectIds?.includes(id)) throw new Error(`busy:${id}`);
            const target = options.catalog?.find((session) => session.id === id);
            if (removeOptions?.requireArchived && target && !target.isArchived) return 'restored';
            harness.removed.push(id);
            options.onRemove?.(id);
            return 'removed';
          },
          list: async () => {
            harness.listCalls += 1;
            if (!options.surviving) throw new Error('catalog unavailable');
            return [...options.surviving];
          },
        },
      },
    },
  });
  return () => {
    if (previous === undefined) delete target.window;
    else Object.defineProperty(target, 'window', { configurable: true, writable: true, value: previous });
  };
}

function createActions(input: {
  harness: SweepHarness;
  sessions: SessionSummary[];
  activeIdRef: { current: string | undefined };
  pending?: Set<string>;
  refreshed?: SessionSummary[];
}) {
  return createAppShellSessionRowActions({
    uiLocale: 'en',
    activeIdRef: input.activeIdRef,
    clearSessionRendererState: (id) => {
      input.harness.cleared.push(id);
    },
    pendingSessionRowActionsRef: { current: input.pending ?? new Set<string>() },
    refreshSessions: async () => input.refreshed ?? [],
    sessionsRef: { current: input.sessions },
    setActiveId: (id) => {
      input.harness.selections.push(id);
      input.activeIdRef.current = id;
    },
    setMessages: () => undefined,
    toastApi: {
      success: (title: string) => {
        input.harness.toasts.push(title);
      },
      error: () => undefined,
      confirm: async () => true,
    },
  });
}

function harness(): SweepHarness {
  return {
    removed: [],
    removeOptions: [],
    cleared: [],
    selections: [],
    toasts: [],
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
    const restore = installWindow(h);
    const actions = createActions({ harness: h, sessions, activeIdRef });

    const outcome = await actions.purgeSessions(['a-v2', 'b']).finally(restore);

    assert.deepEqual(h.removed, ['a-v2', 'b']);
    assert.deepEqual(outcome, {
      removed: 2,
      remaining: [],
      restored: [],
      verified: true,
      firstError: undefined,
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

  it('reports a task restored before the sweep reached it, rather than dropping it', async () => {
    // The confirm named a set. One restored from another surface while the
    // dialog was up has left it, and a sweep that deleted it anyway would be
    // acting outside what was agreed to. Reporting it is the other half: the
    // person agreed to two and one went, which needs saying.
    const h = harness();
    const catalog = [restored('kept'), summary('doomed')];
    const restore = installWindow(h, { catalog });
    const actions = createActions({
      harness: h,
      sessions: [...catalog],
      activeIdRef: { current: undefined },
    });

    const outcome = await actions.purgeSessions(['kept', 'doomed']).finally(restore);

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
    const restore = installWindow(h, {
      catalog,
      onRemove: (id) => {
        if (id === 'first') catalog[1] = restored('second');
      },
    });
    const actions = createActions({
      harness: h,
      sessions: [...catalog],
      activeIdRef: { current: undefined },
    });

    const outcome = await actions.purgeSessions(['first', 'second']).finally(restore);

    assert.deepEqual(h.removed, ['first']);
    assert.equal(outcome.removed, 1);
    assert.deepEqual(outcome.restored, ['second']);
    assert.deepEqual(outcome.remaining, []);
  });

  it('keeps everything the renderer holds for a task the delete left alone', async () => {
    const h = harness();
    const catalog = [summary('first'), restored('rescued')];
    const restore = installWindow(h, { catalog });
    const activeIdRef = { current: 'rescued' as string | undefined };
    const actions = createActions({ harness: h, sessions: [...catalog], activeIdRef });

    const outcome = await actions.purgeSessions(['first', 'rescued']).finally(restore);

    assert.deepEqual(outcome.restored, ['rescued']);
    assert.equal(outcome.firstError, undefined);
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
    const restore = installWindow(h, { catalog: [summary('stale'), summary('plain')] });
    const actions = createActions({
      harness: h,
      sessions: [restored('stale'), summary('plain')],
      activeIdRef: { current: undefined },
    });

    const outcome = await actions.purgeSessions(['stale', 'plain']).finally(restore);

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
    const restore = installWindow(h, { surviving: [summary('busy')] });
    const actions = createActions({
      harness: h,
      sessions,
      activeIdRef: { current: undefined },
      pending: new Set(['busy:delete']),
    });

    const outcome = await actions.purgeSessions(['busy', 'free']).finally(restore);

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
    const restore = installWindow(h, {
      rejectIds: ['committed', 'survivor'],
      surviving: [summary('survivor')],
    });
    const actions = createActions({ harness: h, sessions, activeIdRef: { current: undefined } });

    const outcome = await actions.purgeSessions(['committed', 'survivor']).finally(restore);

    assert.equal(h.listCalls, 1);
    assert.deepEqual(outcome.remaining, ['survivor']);
    assert.equal(outcome.removed, 1);
    assert.equal((outcome.firstError as Error).message, 'busy:committed');
  });

  it('claims nothing when the catalog cannot be read back', async () => {
    // `refreshSessions` would have answered with the pre-delete list here, and
    // reporting on that would have called a completed sweep a total failure.
    const h = harness();
    const sessions = [summary('a')];
    const restore = installWindow(h, { rejectIds: ['a'], surviving: undefined });
    const actions = createActions({
      harness: h,
      sessions,
      activeIdRef: { current: undefined },
      refreshed: sessions,
    });

    const outcome = await actions.purgeSessions(['a']).finally(restore);

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
    const restore = installWindow(h);
    const actions = createActions({ harness: h, sessions, activeIdRef: { current: undefined } });

    await actions.deleteSession('archived-row');
    await actions.deleteSession('active-row');
    restore();

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
    const restore = installWindow(h, { catalog: [restored('rescued')] });
    const activeIdRef = { current: 'rescued' as string | undefined };
    const actions = createActions({ harness: h, sessions, activeIdRef });

    await actions.deleteSession('rescued');
    restore();

    assert.deepEqual(h.removed, []);
    assert.deepEqual(h.cleared, []);
    assert.equal(activeIdRef.current, 'rescued');
    // Not "Deleted rescued": nothing was.
    assert.deepEqual(h.toasts, ['rescued was restored, so it was kept']);
  });
});
