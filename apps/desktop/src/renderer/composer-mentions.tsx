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

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { ChatDefaultPermissionMode } from '@maka/core/settings';
import type { InvocableSkillEntry } from '@maka/runtime/skill-invocation';
import type { DesktopNewTaskTarget } from '../preload/bridge-contract.js';

/** One frozen identity, so a context-mismatch render does not churn props. */
const EMPTY_SKILLS: InvocableSkillEntry[] = [];

/**
 * Whether a reloaded projection describes the same Skills as the one on
 * screen, so an unchanged refresh can keep the array it already published.
 */
function invocableSkillListsEqual(
  current: readonly InvocableSkillEntry[],
  next: readonly InvocableSkillEntry[],
): boolean {
  if (current.length !== next.length) return false;
  return current.every((skill, index) => {
    const other = next[index];
    return (
      other !== undefined &&
      skill.ref === other.ref &&
      skill.id === other.id &&
      skill.name === other.name &&
      skill.description === other.description
    );
  });
}

/** What the composer needs to render its `/` and `@` popups. */
export interface ComposerMentions {
  mentionSkills: ReadonlyArray<{ ref?: string; id: string; name: string; description?: string }>;
  mentionSkillsUnavailable: boolean;
  mentionSkillsLoading: boolean;
  searchMentionFiles(query: string): Promise<ReadonlyArray<{ relativePath: string }>>;
}

/** Which backend surface the popups should describe. */
export interface ComposerMentionsSurface {
  /** Invalidates Runtime's invocable projection after installed Skills settle. */
  skillCatalogRevision: number;
  sessionId?: string;
  projectPath?: string;
  newSessionModel?: { llmConnectionSlug: string; model: string };
  newSessionCollaborationMode?: 'agent' | 'plan';
  newSessionPermissionMode?: ChatDefaultPermissionMode;
  newTaskTarget?: DesktopNewTaskTarget;
}

/**
 * Owns the composer mention popup wiring so app-shell.tsx keeps no inline
 * `window.maka` state (app-shell-composer-attachment-owner-contract). Derives
 * the `/` popup's skill list from Runtime's authoritative invocable projection, and
 * exposes a fail-soft file-search callback backed by the `workspace:searchFiles`
 * IPC. Both return values are memoized so the Composer props keep stable
 * identities across renders.
 */
function useComposerMentions(options: ComposerMentionsSurface): ComposerMentions {
  const {
    projectPath,
    sessionId,
    skillCatalogRevision,
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
  }>({ contextKey, loading: true, skills: EMPTY_SKILLS });
  const liveCatalog = catalog.contextKey === contextKey
    ? catalog
    : { contextKey, loading: true, settled: undefined, skills: EMPTY_SKILLS };

  useEffect(() => {
    let cancelled = false;
    let requestVersion = 0;
    const refresh = () => {
      const version = ++requestVersion;
      setCatalog((previous) =>
        previous.contextKey === contextKey
          ? // A same-context refresh keeps both its settled verdict and the
            // Skills already on screen. Clearing here is what made an open `/`
            // menu alternate between its commands-only and commands-plus-skills
            // geometries on every session or MCP event (#2667). The backend
            // surface has not changed, so there is nothing to fail closed
            // against; and a Skill withdrawn inside the one-IPC-round-trip
            // stale window still fails safely, because selection resolves
            // through the Runtime resolver that no longer knows it.
            { ...previous, loading: true }
          : // A context switch has nothing settled to hold, and its Skills
            // belong to the surface being left behind.
            { contextKey, loading: true, settled: undefined, skills: EMPTY_SKILLS },
      );
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
          setCatalog((previous) => ({
            contextKey,
            loading: false,
            settled: next.length === 0 ? 'empty' : 'populated',
            // A refresh that changed nothing keeps the previous array
            // identity, so the composer's trigger memo and the menu-replay
            // effect stay quiet instead of remounting the popup.
            skills:
              previous.contextKey === contextKey &&
              invocableSkillListsEqual(previous.skills, next)
                ? previous.skills
                : [...next],
          }));
        },
        () => {
          // Fail soft: an unavailable projection leaves `/` with no suggestions.
          // Direct `/skill:<id>` input still reaches the same Runtime resolver.
          if (cancelled || version !== requestVersion) return;
          setCatalog({ contextKey, loading: false, settled: 'empty', skills: EMPTY_SKILLS });
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
    skillCatalogRevision,
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

/**
 * Undefined, not an empty projection. A composer rendered outside the shell —
 * the draft-handoff suite mounts `ChatComposerRegion` on its own — must see
 * exactly what it saw when these arrived as optional props: nothing. Standing
 * in an empty catalog instead flips `onSearchMentionFiles` from absent to
 * present, and the Composer mounts the mention popup's layer for a surface
 * that has no catalog behind it.
 */
const ComposerMentionsContext = createContext<ComposerMentions | undefined>(undefined);

/**
 * Publishes the mention projection to whichever composers are on screen.
 *
 * The catalog reloads on every session switch and on every MCP or session
 * change event, several times per switch. Holding it in AppShell put those
 * reloads above the whole tree, so each one re-rendered ~1600 components to
 * repaint two popups. Owning it here keeps the reload inside this provider:
 * `children` is the element AppShell already built, so React bails out of the
 * subtree and only the composers that read the context re-render.
 */
export function ComposerMentionsProvider({
  children,
  ...surface
}: ComposerMentionsSurface & { children: ReactNode }) {
  const {
    mentionSkills,
    mentionSkillsUnavailable,
    mentionSkillsLoading,
    searchMentionFiles,
  } = useComposerMentions(surface);
  // Destructured so the dependencies ARE the materials. Memoizing the returned
  // object against a hand-listed mirror of its fields reads the same until a
  // fifth field is added and not mirrored — then consumers keep a wholly stale
  // value, and no lint rule can see it.
  const value = useMemo(
    () => ({
      mentionSkills,
      mentionSkillsUnavailable,
      mentionSkillsLoading,
      searchMentionFiles,
    }),
    [mentionSkills, mentionSkillsUnavailable, mentionSkillsLoading, searchMentionFiles],
  );
  return <ComposerMentionsContext.Provider value={value}>{children}</ComposerMentionsContext.Provider>;
}

export function useComposerMentionsContext(): ComposerMentions | undefined {
  return useContext(ComposerMentionsContext);
}
