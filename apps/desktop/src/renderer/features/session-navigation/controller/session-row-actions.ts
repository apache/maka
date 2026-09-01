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

import type { SessionSummary } from '@maka/core/session';
import type { UiLocale } from '@maka/core/ui-locale';
import { getShellCopy, localizedShellErrorMessage } from '../../../locales/shell-copy.js';
import { revisionFamilySessionIds } from '@maka/core/session-revisions';
import type { SessionNavigationSessionService } from '../ports.js';

type RefBox<T> = { current: T };

/** What `sessions.remove` settled on. `restored` means the task is still there. */
type SessionRemoveDisposition = 'removed' | 'restored';

/**
 * How a delete settled together with the count the Host actually archived.
 * `archivedSubtaskCount` is the Host's executed number — 0 when the delete was
 * called off (`restored`) — so the toast reports a fact, not a renderer guess.
 */
type SessionRemoveOutcome = {
  disposition: SessionRemoveDisposition;
  archivedSubtaskCount: number;
};

type ToastApi = {
  success(title: string, description?: string): void;
  error(
    title: string,
    description?: string,
    diagnosticDetails?: string,
    diagnosticTarget?: { sessionId: string },
  ): void;
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
  /**
   * Linked subtasks the Host moved to the archive across the sweep, summed from
   * each removal's executed count. Reported so a bulk purge does not silently
   * archive active subtasks.
   */
  archivedSubtasks: number;
  /** Tasks the catalog still reports. Empty when `verified` is false. */
  remaining: string[];
  /**
   * Tasks restored while the sweep was reaching them. Neither removed nor
   * failed: the deletion was called off because its premise was gone.
   */
  restored: string[];
  verified: boolean;
  /** First rejection and the Session whose Host produced it. */
  firstFailure?: {
    error: unknown;
    sessionId: string;
  };
}

/**
 * What a bulk archive can honestly say afterwards. There is no third
 * disposition: a task is archived or its call failed.
 */
export interface SessionArchiveOutcome {
  archived: number;
  /** Tasks the sweep could not archive, including ones it had to skip. */
  failed: string[];
  /** First rejection and the Session whose Host produced it. */
  firstFailure?: {
    error: unknown;
    sessionId: string;
  };
}

export interface SessionNavigationRowActions {
  flagSession(sessionId: string, flagged: boolean): Promise<void>;
  archiveSession(sessionId: string): Promise<void>;
  unarchiveSession(sessionId: string): Promise<void>;
  renameSession(sessionId: string, name: string): Promise<void>;
  deleteSession(sessionId: string): Promise<void>;
  purgeSessions(sessionIds: readonly string[]): Promise<SessionPurgeOutcome>;
  deleteSessions(sessionIds: readonly string[]): Promise<SessionPurgeOutcome>;
  archiveSessions(sessionIds: readonly string[]): Promise<SessionArchiveOutcome>;
  /** Confirms, sweeps, and reports — the rail's own wording. */
  archiveSelected(sessionIds: readonly string[]): Promise<void>;
  deleteSelected(sessionIds: readonly string[]): Promise<void>;
}

export function createSessionNavigationRowActions(deps: {
  uiLocale: UiLocale;
  activeIdRef: RefBox<string | undefined>;
  clearActiveMessages: () => void;
  clearSessionRendererState: (sessionId: string) => void;
  pendingSessionRowActionsRef: RefBox<Set<string>>;
  refreshSessions: () => Promise<ReadonlyArray<SessionSummary>>;
  service: SessionNavigationSessionService;
  sessionsRef: RefBox<ReadonlyArray<SessionSummary>>;
  setActiveId: (sessionId: string | undefined) => void;
  toastApi: ToastApi;
}): SessionNavigationRowActions {
  const {
    uiLocale,
    activeIdRef,
    clearActiveMessages,
    clearSessionRendererState,
    pendingSessionRowActionsRef,
    refreshSessions,
    service,
    sessionsRef,
    setActiveId,
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
      toastApi.error(
        errorTitle,
        localizedShellErrorMessage(error, copy.actionFallback, uiLocale),
        undefined,
        { sessionId },
      );
    } finally {
      pendingSessionRowActionsRef.current.delete(key);
    }
  }

  async function flagSession(sessionId: string, flagged: boolean) {
    return runSessionRowAction(sessionId, 'flag', flagged ? copy.flagFailedTitle : copy.unflagFailedTitle, async () => {
      await service.setFlagged(sessionId, flagged, { revisionFamily: true });
      await refreshSessions();
    });
  }

  async function archiveSession(sessionId: string) {
    return runSessionRowAction(sessionId, 'archive', copy.archiveFailedTitle, async () => {
      const familyIds = revisionFamilySessionIds(sessionsRef.current, sessionId);
      await service.archive(sessionId, { revisionFamily: true });
      if (activeIdRef.current && familyIds.includes(activeIdRef.current)) {
        setActiveId(undefined);
        clearActiveMessages();
      }
      for (const id of familyIds) clearSessionRendererState(id);
      await refreshSessions();
    });
  }

  async function unarchiveSession(sessionId: string) {
    return runSessionRowAction(sessionId, 'archive', copy.unarchiveFailedTitle, async () => {
      await service.unarchive(sessionId, { revisionFamily: true });
      await refreshSessions();
    });
  }

  async function renameSession(sessionId: string, name: string) {
    return runSessionRowAction(sessionId, 'rename', copy.renameFailedTitle, async () => {
      await service.rename(sessionId, name, { revisionFamily: true });
      await refreshSessions();
    });
  }

  async function deleteSession(sessionId: string) {
    return runSessionRowAction(sessionId, 'delete', copy.deleteFailedTitle, async () => {
      const session = sessionsRef.current.find((entry) => entry.id === sessionId);
      const name = session?.name ?? copy.currentConversation;
      // Ask the Host how many subtasks the delete would archive. It owns the
      // removal plan; the renderer's catalog projection lacks the operator
      // marker and copy state, so a renderer estimate would over-promise (e.g.
      // claim archival for a parent whose only children are graph operators).
      // A preview failure is not silence: fall back to an uncertain warning so
      // the confirm never hides that subtasks may survive. The toast still
      // reports the real executed count afterwards.
      let previewSubtaskCount: number | undefined;
      try {
        previewSubtaskCount = await service.previewRemoval(sessionId);
      } catch {
        previewSubtaskCount = undefined;
      }
      const subtaskNote =
        previewSubtaskCount === undefined
          ? copy.deleteSubtaskNoteUncertain()
          : previewSubtaskCount > 0
            ? copy.deleteSubtaskNote()
            : undefined;
      const ok = await toastApi.confirm({
        title: copy.deleteTitle(name),
        description: subtaskNote
          ? `${copy.deleteDescription} ${subtaskNote}`
          : copy.deleteDescription,
        confirmLabel: copy.deleteLabel,
        cancelLabel: copy.cancelLabel,
        destructive: true,
      });
      if (!ok) return;
      // The confirm named an archived task, so a restore revokes it. An active
      // task has no such premise to lose.
      const { disposition, archivedSubtaskCount } = await removeSessionFamily(sessionId, {
        requireArchived: session?.isArchived === true,
      });
      await refreshSessions();
      // `restored` means nothing was deleted, so no subtask moved either. On a
      // real delete the count is the Host's executed number, not an estimate.
      if (disposition === 'restored') toastApi.success(copy.deleteRestoredTitle(name));
      else
        toastApi.success(
          copy.deletedTitle(name),
          archivedSubtaskCount > 0 ? copy.deletedSubtaskNote(archivedSubtaskCount) : undefined,
        );
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
  ): Promise<SessionRemoveOutcome> {
    // Read before the write: the family comes off the live catalog, which no
    // longer lists it afterwards.
    const familyIds = revisionFamilySessionIds(sessionsRef.current, sessionId);
    const outcome = await service.remove(sessionId, {
      revisionFamily: true,
      requireArchived: options.requireArchived,
    });
    if (outcome.disposition === 'restored') return outcome;
    if (activeIdRef.current && familyIds.includes(activeIdRef.current)) {
      setActiveId(undefined);
      clearActiveMessages();
    }
    for (const id of familyIds) clearSessionRendererState(id);
    return outcome;
  }

  /**
   * Deletes a set of tasks in one sweep.
   *
   * `requireArchivedFor` decides, per id, whether the deletion asserts that the
   * task is still archived. Settings' purge asserts it for every target; the
   * rail reads it off the task, exactly as single-row delete does, because the
   * rail lists unarchived tasks and asserting it there would refuse them all.
   *
   * Every id takes one path and lands in exactly one outcome. A task whose
   * premise still holds is removed; one restored meanwhile answers `restored`
   * and is kept; one already gone elsewhere rejects and settles as removed
   * against the catalog; anything else is an error to explain. The premise is
   * asserted where it can be held — inside the Host's compare-and-set (#3050) —
   * rather than against a renderer snapshot that a second window can outdate
   * between the check and the write.
   *
   * Ids with a row action already in flight are skipped for the same reason
   * single-row actions skip each other.
   *
   * A rejection is not evidence the task survived — the delete IPC commits the
   * removal before it releases renderer resources — so the rejected ids, and
   * only those, are checked back against the catalog. `refreshSessions` cannot
   * answer that: it swallows a listing failure and returns the pre-delete list,
   * which would read as "none of them went". When the catalog cannot be read at
   * all, `verified` is false and the caller claims nothing.
   *
   * No confirm and no toast: the caller owns the wording for a sweep, which is
   * the one thing single-row delete cannot phrase.
   */
  async function sweepSessions(
    sessionIds: readonly string[],
    requireArchivedFor: (sessionId: string) => boolean,
  ): Promise<SessionPurgeOutcome> {
    const unsettled: string[] = [];
    const restored: string[] = [];
    let firstFailure: SessionPurgeOutcome['firstFailure'];
    let removed = 0;
    let archivedSubtasks = 0;
    for (const sessionId of sessionIds) {
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
        const { disposition, archivedSubtaskCount } = await removeSessionFamily(sessionId, {
          requireArchived: requireArchivedFor(sessionId),
        });
        if (disposition === 'restored') restored.push(sessionId);
        else {
          removed += 1;
          archivedSubtasks += archivedSubtaskCount;
        }
      } catch (error) {
        unsettled.push(sessionId);
        firstFailure ??= { error, sessionId };
      } finally {
        pendingSessionRowActionsRef.current.delete(key);
      }
    }
    if (unsettled.length === 0) {
      await refreshSessions();
      return {
        removed,
        archivedSubtasks,
        remaining: [],
        restored,
        verified: true,
        firstFailure,
      };
    }
    let listed: SessionSummary[] | undefined;
    try {
      listed = await service.list();
    } catch {
      listed = undefined;
    }
    await refreshSessions();
    if (!listed) {
      return {
        removed,
        archivedSubtasks,
        remaining: [],
        restored,
        verified: false,
        firstFailure,
      };
    }
    const present = new Set(listed.map((session) => session.id));
    const remaining = unsettled.filter((sessionId) => present.has(sessionId));
    return {
      removed: removed + (unsettled.length - remaining.length),
      archivedSubtasks,
      remaining,
      restored,
      verified: true,
      firstFailure,
    };
  }

  /**
   * Settings › archived tasks. Every target is archived by definition, and the
   * premise is asserted anyway so a task restored between the confirm and the
   * write is kept rather than removed.
   */
  async function purgeSessions(sessionIds: readonly string[]): Promise<SessionPurgeOutcome> {
    return sweepSessions(sessionIds, () => true);
  }

  /**
   * The rail's multi-select delete. The rail lists unarchived tasks, so the
   * archived premise is read per task exactly as single-row delete reads it:
   * asserting it for a task that was never archived would refuse every
   * deletion the rail can actually ask for.
   *
   * No confirm here either — one sweep is one question, and only the caller
   * knows how many tasks it is about to name.
   */
  async function deleteSessions(sessionIds: readonly string[]): Promise<SessionPurgeOutcome> {
    return sweepSessions(
      sessionIds,
      (sessionId) =>
        sessionsRef.current.find((entry) => entry.id === sessionId)?.isArchived === true,
    );
  }

  /**
   * The rail's multi-select archive.
   *
   * Archiving has no disposition to report — a task is archived or the call
   * failed — so this accounts by count and first failure rather than reusing
   * the delete sweep's shape, which would carry a `restored` field that can
   * never be anything but empty.
   *
   * Like the sweep, it raises no toast per task: one action is one message, and
   * a run of them is what a sweep exists to avoid.
   */
  async function archiveSessions(sessionIds: readonly string[]): Promise<SessionArchiveOutcome> {
    const failed: string[] = [];
    let firstFailure: SessionArchiveOutcome['firstFailure'];
    let archived = 0;
    for (const sessionId of sessionIds) {
      const key = `${sessionId}:archive`;
      if (
        Array.from(pendingSessionRowActionsRef.current).some((pending) =>
          pending.startsWith(`${sessionId}:`),
        )
      ) {
        failed.push(sessionId);
        continue;
      }
      pendingSessionRowActionsRef.current.add(key);
      try {
        const familyIds = revisionFamilySessionIds(sessionsRef.current, sessionId);
        await service.archive(sessionId, { revisionFamily: true });
        if (activeIdRef.current && familyIds.includes(activeIdRef.current)) {
          setActiveId(undefined);
          clearActiveMessages();
        }
        for (const id of familyIds) clearSessionRendererState(id);
        archived += 1;
      } catch (error) {
        failed.push(sessionId);
        firstFailure ??= { error, sessionId };
      } finally {
        pendingSessionRowActionsRef.current.delete(key);
      }
    }
    // Once, after the whole sweep. Refreshing per task would re-render the rail
    // under the user's cursor for every id in the selection.
    await refreshSessions();
    return { archived, failed, firstFailure };
  }

  /**
   * The rail's own bulk archive, wording included.
   *
   * The sweeps below it stay silent on purpose — Settings' purge phrases its
   * own confirm — but the rail's phrasing belongs to the rail, and this module
   * is where the feature already holds its copy. Putting it in the selection
   * hook instead would have made that hook the feature's second importer of
   * renderer legacy copy, which the architecture check refuses.
   */
  async function archiveSelected(sessionIds: readonly string[]): Promise<void> {
    if (sessionIds.length === 0) return;
    const ok = await toastApi.confirm({
      title: copy.bulkArchiveTitle(sessionIds.length),
      description: copy.bulkArchiveDescription,
      confirmLabel: copy.bulkArchiveLabel,
      cancelLabel: copy.cancelLabel,
    });
    if (!ok) return;
    const outcome = await archiveSessions(sessionIds);
    if (outcome.failed.length === 0) {
      toastApi.success(copy.bulkArchivedTitle(outcome.archived));
      return;
    }
    toastApi.error(
      copy.bulkArchiveFailedTitle,
      outcome.firstFailure
        ? localizedShellErrorMessage(outcome.firstFailure.error, copy.actionFallback, uiLocale)
        : copy.bulkFailedBody(outcome.failed.length),
      undefined,
      outcome.firstFailure ? { sessionId: outcome.firstFailure.sessionId } : undefined,
    );
  }

  /**
   * The rail's own bulk delete. See `archiveSelected` for why the wording is here.
   *
   * The confirm warns about linked subtasks for the same reason single-row
   * delete does: the Host archives a deleted parent's ordinary subagent tasks
   * rather than deleting them, so without the warning they reappear under
   * Archived with no explanation. The Host owns that plan — the renderer's
   * catalog projection lacks the operator marker — so the count is asked for,
   * one preview per selected task, and a single failure makes the whole warning
   * uncertain rather than silently under-reporting the set.
   *
   * N previews before a destructive confirm is N round trips, which is the
   * price of naming a number the user can act on. The toast afterwards reports
   * the Host's executed total, not this estimate.
   */
  async function deleteSelected(sessionIds: readonly string[]): Promise<void> {
    if (sessionIds.length === 0) return;
    let previewedSubtasks: number | undefined = 0;
    for (const sessionId of sessionIds) {
      try {
        const count = await service.previewRemoval(sessionId);
        if (previewedSubtasks !== undefined) previewedSubtasks += count;
      } catch {
        previewedSubtasks = undefined;
      }
    }
    const subtaskNote =
      previewedSubtasks === undefined
        ? copy.bulkDeleteSubtaskNoteUncertain()
        : previewedSubtasks > 0
          ? copy.bulkDeleteSubtaskNote()
          : undefined;
    const ok = await toastApi.confirm({
      title: copy.bulkDeleteTitle(sessionIds.length),
      description: subtaskNote
        ? `${copy.bulkDeleteDescription} ${subtaskNote}`
        : copy.bulkDeleteDescription,
      confirmLabel: copy.deleteLabel,
      cancelLabel: copy.cancelLabel,
      destructive: true,
    });
    if (!ok) return;
    const outcome = await deleteSessions(sessionIds);
    // Kept tasks and failures are independent, and reporting one while dropping
    // the other is how a count quietly stops adding up.
    const kept =
      outcome.restored.length > 0 ? copy.bulkKeptRestored(outcome.restored.length) : undefined;
    // The Host's executed number, not the preview's estimate.
    const archived =
      outcome.archivedSubtasks > 0 ? copy.deletedSubtaskNote(outcome.archivedSubtasks) : undefined;
    if (outcome.verified && outcome.remaining.length === 0) {
      toastApi.success(
        copy.bulkDeletedTitle(outcome.removed),
        [kept, archived].filter(Boolean).join(' ') || undefined,
      );
      return;
    }
    const reason = !outcome.verified
      ? copy.bulkUnverified
      : outcome.firstFailure
        ? localizedShellErrorMessage(outcome.firstFailure.error, copy.actionFallback, uiLocale)
        : copy.bulkFailedBody(outcome.remaining.length);
    toastApi.error(
      copy.bulkDeleteFailedTitle,
      [reason, kept, archived].filter(Boolean).join(' '),
      undefined,
      outcome.firstFailure ? { sessionId: outcome.firstFailure.sessionId } : undefined,
    );
  }

  return {
    flagSession,
    archiveSession,
    unarchiveSession,
    renameSession,
    deleteSession,
    purgeSessions,
    deleteSessions,
    archiveSessions,
    archiveSelected,
    deleteSelected,
  };
}
