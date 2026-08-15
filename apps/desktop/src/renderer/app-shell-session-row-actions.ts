import type { SessionSummary, StoredMessage } from '@maka/core/session';
import type { UiLocale } from '@maka/core/ui-locale';
import { getShellCopy, localizedShellErrorMessage } from './locales/shell-copy.js';
import { revisionFamilySessionIds } from '@maka/core/session-revisions';

type RefBox<T> = { current: T };

/** What `sessions.remove` settled on. `restored` means the task is still there. */
type SessionRemoveDisposition = 'removed' | 'restored';

type ToastApi = {
  success(title: string, description?: string): void;
  error(title: string, description?: string): void;
  confirm(options: {
    title: string;
    description: string;
    confirmLabel: string;
    cancelLabel: string;
    destructive?: boolean;
  }): Promise<boolean>;
};

/**
 * What a sweep can honestly say afterwards. `verified: false` means the catalog
 * could not be read back, so neither `remaining` nor a success claim is safe.
 */
export interface SessionPurgeOutcome {
  /** Tasks confirmed gone. */
  removed: number;
  /** Tasks the catalog still reports. Empty when `verified` is false. */
  remaining: string[];
  /**
   * Tasks restored while the sweep was reaching them. Neither removed nor
   * failed: the deletion was called off because its premise was gone.
   */
  restored: string[];
  verified: boolean;
  /** First rejection, so the caller can show a reason rather than a count. */
  firstError: unknown;
}

export interface AppShellSessionRowActions {
  flagSession(sessionId: string, flagged: boolean): Promise<void>;
  archiveSession(sessionId: string): Promise<void>;
  unarchiveSession(sessionId: string): Promise<void>;
  renameSession(sessionId: string, name: string): Promise<void>;
  deleteSession(sessionId: string): Promise<void>;
  purgeSessions(sessionIds: readonly string[]): Promise<SessionPurgeOutcome>;
}

export function createAppShellSessionRowActions(deps: {
  uiLocale: UiLocale;
  activeIdRef: RefBox<string | undefined>;
  clearSessionRendererState: (sessionId: string) => void;
  pendingSessionRowActionsRef: RefBox<Set<string>>;
  refreshSessions: () => Promise<SessionSummary[]>;
  sessionsRef: RefBox<SessionSummary[]>;
  setActiveId: (sessionId: string | undefined) => void;
  setMessages: (messages: StoredMessage[]) => void;
  toastApi: ToastApi;
}): AppShellSessionRowActions {
  const {
    uiLocale,
    activeIdRef,
    clearSessionRendererState,
    pendingSessionRowActionsRef,
    refreshSessions,
    sessionsRef,
    setActiveId,
    setMessages,
    toastApi,
  } = deps;
  const copy = getShellCopy(uiLocale).sessionRowActions;

  async function runSessionRowAction(
    sessionId: string,
    actionId: 'flag' | 'archive' | 'rename' | 'delete',
    errorTitle: string,
    action: () => Promise<void>,
  ): Promise<void> {
    const sessionPrefix = `${sessionId}:`;
    if (Array.from(pendingSessionRowActionsRef.current).some((key) => key.startsWith(sessionPrefix))) return;
    const key = `${sessionId}:${actionId}`;
    pendingSessionRowActionsRef.current.add(key);
    try {
      await action();
    } catch (error) {
      toastApi.error(errorTitle, localizedShellErrorMessage(error, copy.actionFallback, uiLocale));
    } finally {
      pendingSessionRowActionsRef.current.delete(key);
    }
  }

  async function flagSession(sessionId: string, flagged: boolean) {
    return runSessionRowAction(sessionId, 'flag', flagged ? copy.flagFailedTitle : copy.unflagFailedTitle, async () => {
      await window.maka.sessions.setFlagged(sessionId, flagged, { revisionFamily: true });
      await refreshSessions();
    });
  }

  async function archiveSession(sessionId: string) {
    return runSessionRowAction(sessionId, 'archive', copy.archiveFailedTitle, async () => {
      const familyIds = revisionFamilySessionIds(sessionsRef.current, sessionId);
      await window.maka.sessions.archive(sessionId, { revisionFamily: true });
      if (activeIdRef.current && familyIds.includes(activeIdRef.current)) {
        setActiveId(undefined);
        setMessages([]);
      }
      for (const id of familyIds) clearSessionRendererState(id);
      await refreshSessions();
    });
  }

  async function unarchiveSession(sessionId: string) {
    return runSessionRowAction(sessionId, 'archive', copy.unarchiveFailedTitle, async () => {
      await window.maka.sessions.unarchive(sessionId, { revisionFamily: true });
      await refreshSessions();
    });
  }

  async function renameSession(sessionId: string, name: string) {
    return runSessionRowAction(sessionId, 'rename', copy.renameFailedTitle, async () => {
      await window.maka.sessions.rename(sessionId, name, { revisionFamily: true });
      await refreshSessions();
    });
  }

  async function deleteSession(sessionId: string) {
    return runSessionRowAction(sessionId, 'delete', copy.deleteFailedTitle, async () => {
      const session = sessionsRef.current.find((entry) => entry.id === sessionId);
      const name = session?.name ?? copy.currentConversation;
      const ok = await toastApi.confirm({
        title: copy.deleteTitle(name),
        description: copy.deleteDescription,
        confirmLabel: copy.deleteLabel,
        cancelLabel: copy.cancelLabel,
        destructive: true,
      });
      if (!ok) return;
      // The confirm named an archived task, so a restore revokes it. An active
      // task has no such premise to lose.
      const disposition = await removeSessionFamily(sessionId, {
        requireArchived: session?.isArchived === true,
      });
      await refreshSessions();
      if (disposition === 'restored') toastApi.success(copy.deleteRestoredTitle(name));
      else toastApi.success(copy.deletedTitle(name));
    });
  }

  /**
   * Removes one task's whole revision family and drops what the renderer was
   * holding for it. A resolved `remove` means the IPC both committed the
   * deletion and released those resources, so the cleanup below is only ever
   * reached for a task that is really gone — and `restored` means it was never
   * deleted, so there is nothing to drop.
   */
  async function removeSessionFamily(
    sessionId: string,
    options: { requireArchived: boolean },
  ): Promise<SessionRemoveDisposition> {
    // Read before the write: the family comes off the live catalog, which no
    // longer lists it afterwards.
    const familyIds = revisionFamilySessionIds(sessionsRef.current, sessionId);
    const disposition = await window.maka.sessions.remove(sessionId, {
      revisionFamily: true,
      requireArchived: options.requireArchived,
    });
    if (disposition === 'restored') return disposition;
    if (activeIdRef.current && familyIds.includes(activeIdRef.current)) {
      setActiveId(undefined);
      setMessages([]);
    }
    for (const id of familyIds) clearSessionRendererState(id);
    return disposition;
  }

  /**
   * Deletes a set of archived tasks in one sweep.
   *
   * Only tasks still archived when the sweep reaches them are touched: the
   * caller named a set to a person, and one restored while that dialog was up
   * has left it. Ids with a row action already in flight are skipped for the
   * same reason single-row actions skip each other.
   *
   * A rejection is not evidence the task survived — the delete IPC commits the
   * removal before it releases renderer resources — so the rejected ids, and
   * only those, are checked back against the catalog. `refreshSessions` cannot
   * answer that: it swallows a listing failure and returns the pre-delete list,
   * which would read as "none of them went". When the catalog cannot be read at
   * all, `verified` is false and the caller claims nothing.
   *
   * A task restored while the sweep was reaching it is reported apart from both:
   * the delete was called off on purpose, so it is neither a removal to count
   * nor an error to explain.
   *
   * No confirm and no toast: the caller owns the wording for a sweep, which is
   * the one thing single-row delete cannot phrase.
   */
  async function purgeSessions(sessionIds: readonly string[]): Promise<SessionPurgeOutcome> {
    const unsettled: string[] = [];
    const restored: string[] = [];
    let firstError: unknown;
    let removed = 0;
    for (const sessionId of sessionIds) {
      // Read the catalog as the sweep reaches each task, not once up front. A
      // sweep is serial, and a task restored from another window while it runs
      // has left the set the confirm named; a snapshot taken at the start would
      // delete it anyway.
      //
      // This is a cheap filter, not the guarantee: a restore landing between
      // this check and the removal is caught by `requireArchived` below, which
      // holds the premise through the Host's compare-and-set (#3050).
      if (!sessionsRef.current.some((s) => s.id === sessionId && s.isArchived)) continue;
      const key = `${sessionId}:delete`;
      if (
        Array.from(pendingSessionRowActionsRef.current).some((pending) =>
          pending.startsWith(`${sessionId}:`),
        )
      ) {
        unsettled.push(sessionId);
        continue;
      }
      pendingSessionRowActionsRef.current.add(key);
      try {
        const disposition = await removeSessionFamily(sessionId, { requireArchived: true });
        if (disposition === 'restored') restored.push(sessionId);
        else removed += 1;
      } catch (error) {
        unsettled.push(sessionId);
        firstError ??= error;
      } finally {
        pendingSessionRowActionsRef.current.delete(key);
      }
    }
    if (unsettled.length === 0) {
      await refreshSessions();
      return { removed, remaining: [], restored, verified: true, firstError };
    }
    let listed: SessionSummary[] | undefined;
    try {
      listed = await window.maka.sessions.list();
    } catch {
      listed = undefined;
    }
    await refreshSessions();
    if (!listed) return { removed, remaining: [], restored, verified: false, firstError };
    const present = new Set(listed.map((session) => session.id));
    const remaining = unsettled.filter((sessionId) => present.has(sessionId));
    return {
      removed: removed + (unsettled.length - remaining.length),
      remaining,
      restored,
      verified: true,
      firstError,
    };
  }

  return {
    flagSession,
    archiveSession,
    unarchiveSession,
    renameSession,
    deleteSession,
    purgeSessions,
  };
}
