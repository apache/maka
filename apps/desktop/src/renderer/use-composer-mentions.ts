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

import { useCallback, useEffect, useState } from 'react';
import type { ChatDefaultPermissionMode } from '@maka/core/settings';
import type { SkillEntry } from '@maka/ui';
import type { InvocableSkillEntry } from '@maka/runtime/skill-invocation';
import type { DesktopNewTaskTarget } from '../preload/bridge-contract.js';

/** One frozen identity, so a context-mismatch render does not churn props. */
const EMPTY_SKILLS: InvocableSkillEntry[] = [];

/**
 * Owns the composer mention popup wiring so app-shell.tsx keeps no inline
 * `window.maka` state (app-shell-composer-attachment-owner-contract). Derives
 * the `/` popup's skill list from Runtime's authoritative invocable projection, and
 * exposes a fail-soft file-search callback backed by the `workspace:searchFiles`
 * IPC. Both return values are memoized so the Composer props keep stable
 * identities across renders.
 */
export function useComposerMentions(options: {
  skills: readonly SkillEntry[];
  sessionId?: string;
  projectPath?: string;
  newSessionModel?: { llmConnectionSlug: string; model: string };
  newSessionCollaborationMode?: 'agent' | 'plan';
  newSessionPermissionMode?: ChatDefaultPermissionMode;
  newTaskTarget?: DesktopNewTaskTarget;
}): {
  mentionSkills: ReadonlyArray<{ ref?: string; id: string; name: string; description?: string }>;
  mentionSkillsUnavailable: boolean;
  mentionSkillsLoading: boolean;
  searchMentionFiles(query: string): Promise<ReadonlyArray<{ relativePath: string }>>;
} {
  const {
    projectPath,
    sessionId,
    skills,
    newSessionModel,
    newSessionCollaborationMode,
    newSessionPermissionMode,
    newTaskTarget,
  } = options;
  // One explicit representation of the Skill catalog — in flight, settled
  // empty, or settled populated — held as a single value so a refresh can
  // never tear its facets apart.
  //
  // `skills` is the live, fail-closed list the `/` popup reads: it is cleared
  // the moment a refresh starts, because a visible popup must never advertise
  // a Skill the new backend surface may not carry. That clear is exactly why
  // `length === 0` cannot tell "re-fetching" from "nothing to offer", so the
  // ＋ menu's Skills row renders from `settled` — the last RESOLVED verdict,
  // held across refreshes of the SAME context — and repaints only when the
  // catalog's emptiness actually changed. `loading` gates interaction: while
  // a request is in flight (including the very first, before anything has
  // settled), a click on the row must have no side effect — the held
  // presentation is the old catalog's look, not a promise the current one
  // can honor.
  //
  // `contextKey` names which backend surface the value describes. The clear
  // above happens in a passive effect, one commit AFTER a session/project/
  // model switch has rendered — a window where the old context's Skills are
  // still on screen for the new one. Deriving through the key below makes the
  // render itself fail closed the moment the context changes, without waiting
  // for the effect.
  const contextKey = [
    sessionId ?? '',
    projectPath ?? '',
    newSessionModel?.llmConnectionSlug ?? '',
    newSessionModel?.model ?? '',
    newSessionCollaborationMode ?? 'agent',
    newSessionPermissionMode ?? '',
    newTaskTarget?.profileId ?? '',
    newTaskTarget?.hostId ?? '',
    newTaskTarget?.projectId ?? '',
  ].join('\u0000');
  const [catalog, setCatalog] = useState<{
    contextKey: string;
    loading: boolean;
    settled?: 'empty' | 'populated';
    skills: InvocableSkillEntry[];
  }>({ contextKey, loading: true, skills: [] });
  const liveCatalog = catalog.contextKey === contextKey
    ? catalog
    : { contextKey, loading: true, settled: undefined, skills: EMPTY_SKILLS };

  useEffect(() => {
    let cancelled = false;
    let requestVersion = 0;
    const refresh = () => {
      const version = ++requestVersion;
      setCatalog((previous) => ({
        contextKey,
        loading: true,
        // A same-context refresh keeps its settled verdict; a context switch
        // has nothing settled to hold.
        settled: previous.contextKey === contextKey ? previous.settled : undefined,
        skills: [],
      }));
      const context = {
        ...(newSessionModel ?? {}),
        collaborationMode: newSessionCollaborationMode ?? 'agent',
        ...(newSessionPermissionMode
          ? { permissionMode: newSessionPermissionMode }
          : {}),
      } as const;
      const request = sessionId
        ? window.maka.skills.listInvocable(sessionId)
        : newTaskTarget
          ? window.maka.newTasks.listInvocableSkills(newTaskTarget, context)
          : Promise.resolve([]);
      void request.then(
        (next) => {
          if (cancelled || version !== requestVersion) return;
          setCatalog({
            contextKey,
            loading: false,
            settled: next.length === 0 ? 'empty' : 'populated',
            skills: next,
          });
        },
        () => {
          // Fail soft: an unavailable projection leaves `/` with no suggestions.
          // Direct `/skill:<id>` input still reaches the same Runtime resolver.
          if (cancelled || version !== requestVersion) return;
          setCatalog({ contextKey, loading: false, settled: 'empty', skills: [] });
        },
      );
    };
    refresh();
    const unsubscribeSessions = window.maka.sessions.subscribeChanges((event) => {
      if (
        sessionId &&
        event.sessionId === sessionId &&
        (event.reason === 'updated' ||
          event.reason === 'mode-change' ||
          event.reason === 'turn-status-change' ||
          event.reason === 'rebound')
      ) {
        refresh();
      }
    });
    const unsubscribeContext = sessionId
      ? window.maka.mcp.subscribeChanges(() => refresh())
      : window.maka.newTasks.subscribeChanges(() => refresh());
    return () => {
      cancelled = true;
      requestVersion += 1;
      unsubscribeSessions();
      unsubscribeContext();
    };
  }, [
    projectPath,
    sessionId,
    skills,
    newSessionModel?.llmConnectionSlug,
    newSessionModel?.model,
    newSessionCollaborationMode,
    newSessionPermissionMode,
    newTaskTarget?.profileId,
    newTaskTarget?.hostId,
    newTaskTarget?.projectId,
  ]);

  const searchMentionFiles = useCallback(
    async (query: string): Promise<ReadonlyArray<{ relativePath: string }>> => {
      try {
        const result = sessionId
          ? await window.maka.workspace.searchFiles(query, { sessionId })
          : newTaskTarget
            ? await window.maka.newTasks.searchFiles(newTaskTarget, query)
            : { ok: false as const, reason: 'no_project' as const };
        return result.ok ? result.files : [];
      } catch {
        // Fail soft: a failed search just yields an empty list, so the popup
        // shows 未找到文件 rather than surfacing an error into the composer.
        return [];
      }
    },
    [
      sessionId,
      newTaskTarget?.profileId,
      newTaskTarget?.hostId,
      newTaskTarget?.projectId,
    ],
  );

  return {
    mentionSkills: liveCatalog.skills,
    mentionSkillsUnavailable: liveCatalog.settled === 'empty',
    mentionSkillsLoading: liveCatalog.loading,
    searchMentionFiles,
  };
}
