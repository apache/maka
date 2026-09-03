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
import type { RefObject } from 'react';
import type {
  SessionNavigationRemoveOutcome,
  SessionNavigationSessionService,
  SessionNavigationToastApi,
} from '../ports.js';

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
 *
 * Not on `SessionNavigationRowActions`: `archiveSelected` is the rail's whole
 * bulk archive, and this is what it reads on the way to its own report.
 */
interface SessionArchiveOutcome {
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
  /** Sweeps and reports — the rail's own wording. */
  archiveSelected(sessionIds: readonly string[]): Promise<void>;
  /** Pins or unpins a picked set in one sweep. */
  flagSelected(sessionIds: readonly string[], flagged: boolean): Promise<void>;
}

export function createSessionNavigationRowActions(deps: {
  uiLocale: UiLocale;
  activeIdRef: RefObject<string | undefined>;
  clearActiveMessages: () => void;
  clearSessionRendererState: (sessionId: string) => void;
  pendingSessionRowActionsRef: RefObject<Set<string>>;
  refreshSessions: () => Promise<ReadonlyArray<SessionSummary>>;
  service: SessionNavigationSessionService;
  sessionsRef: RefObject<ReadonlyArray<SessionSummary>>;
  setActiveId: (sessionId: string | undefined) => void;
  toastApi: SessionNavigationToastApi;
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
  ): Promise<SessionNavigationRemoveOutcome> {
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
   * Settings › 已归档任务, sweeping a set of archived tasks in one pass. The one
   * bulk delete the product has: the rail cannot delete at all, so every target
   * here is archived by definition, and the premise is asserted anyway so a task
   * restored between the confirm and the write is kept rather than removed.
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
  async function purgeSessions(sessionIds: readonly string[]): Promise<SessionPurgeOutcome> {
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
          requireArchived: true,
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
   * `archiveSessions` above it stays silent on purpose: it counts, and the
   * caller words the count. The rail's phrasing belongs to the rail, and this
   * module is where the feature already holds its copy. Putting it in the
   * selection hook instead would have made that hook the feature's second
   * importer of renderer legacy copy, which the architecture check refuses.
   *
   * NO CONFIRM, at one row or twenty. Archiving is reversible, the single-row
   * ⋯ has never asked, and a dialog in front of one of two identical verbs
   * teaches that the count is what makes an action dangerous rather than the
   * action. The dialog's one piece of information — where the tasks went — is
   * kept, as the success toast's description.
   */
  async function archiveSelected(sessionIds: readonly string[]): Promise<void> {
    if (sessionIds.length === 0) return;
    const outcome = await archiveSessions(sessionIds);
    if (outcome.failed.length === 0) {
      toastApi.success(copy.bulkArchivedTitle(outcome.archived), copy.bulkArchiveDescription);
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
   * The rail's bulk pin, in one direction for the whole set.
   *
   * The direction is the caller's: the menu shows 取消置顶 only when every
   * picked row is already pinned, so a mixed set pins — which is the one rule
   * that keeps a set-wide toggle from meaning something different for each row
   * in it.
   *
   * Silent on success. Pinning moves the rows between 置顶 and 最近 in front of
   * the user, which says it better than a toast, and the single-row pin has
   * never raised one either.
   */
  async function flagSelected(sessionIds: readonly string[], flagged: boolean): Promise<void> {
    if (sessionIds.length === 0) return;
    const failed: string[] = [];
    let firstFailure: { error: unknown; sessionId: string } | undefined;
    for (const sessionId of sessionIds) {
      const key = `${sessionId}:flag`;
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
        await service.setFlagged(sessionId, flagged, { revisionFamily: true });
      } catch (error) {
        failed.push(sessionId);
        firstFailure ??= { error, sessionId };
      } finally {
        pendingSessionRowActionsRef.current.delete(key);
      }
    }
    // Once, after the whole sweep. Refreshing per task would re-render the rail
    // under the user's cursor for every id in the set.
    await refreshSessions();
    if (failed.length === 0) return;
    toastApi.error(
      flagged ? copy.flagFailedTitle : copy.unflagFailedTitle,
      firstFailure
        ? localizedShellErrorMessage(firstFailure.error, copy.actionFallback, uiLocale)
        : copy.bulkFailedBody(failed.length),
      undefined,
      firstFailure ? { sessionId: firstFailure.sessionId } : undefined,
    );
  }

  return {
    flagSession,
    archiveSession,
    unarchiveSession,
    renameSession,
    deleteSession,
    purgeSessions,
    archiveSelected,
    flagSelected,
  };
}
