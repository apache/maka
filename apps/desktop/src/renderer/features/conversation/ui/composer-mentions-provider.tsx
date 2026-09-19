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

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { getConversationCopy, useUiLocale } from '@maka/ui';
import type { ChatDefaultPermissionMode } from '@maka/core/settings';
import type { QuoteRef } from '@maka/core/events';
import type { InvocableSkillEntry } from '@maka/runtime/skill-invocation';
import type { ConversationSession } from '../ports.js';
import { useConversationServices } from '../services.js';
import {
  useSessionReferenceComposer,
  type SessionReferenceSession,
} from '../controller/use-session-reference-composer.js';

export interface ComposerMentionsSurface {
  readonly skillCatalogRevision: number;
  readonly sessionId?: string;
  readonly projectPath?: string;
  readonly newSessionModel?: { llmConnectionSlug: string; model: string };
  readonly newSessionCollaborationMode?: 'agent' | 'plan';
  readonly newSessionPermissionMode?: ChatDefaultPermissionMode;
  readonly newTaskTarget?: {
    readonly profileId: string;
    readonly hostId: string;
    readonly projectId: string | null;
  };
  readonly onAddQuote?: (quote: QuoteRef) => void;
  readonly pendingQuotes?: readonly QuoteRef[];
}


export interface ComposerMentions {
  readonly mentionSkills: ReadonlyArray<{
    ref?: string;
    id: string;
    name: string;
    description?: string;
  }>;
  readonly mentionSkillsUnavailable: boolean;
  readonly mentionSkillsLoading: boolean;
  searchMentionFiles(query: string): Promise<ReadonlyArray<{ relativePath: string }>>;
  readonly sessionReferences: ReadonlyArray<SessionReferenceSession>;
  readonly onPickSessionReference?: (session: SessionReferenceSession) => Promise<void>;
  readonly pendingSessionReferences: ReadonlyArray<SessionReferenceSession>;
  onRemovePendingSessionReference(sessionId: string): void;
  readonly sessionReferenceError?: { title: string; detail: string };
  waitForSessionReference(): Promise<boolean>;
}

const EMPTY_SKILLS: InvocableSkillEntry[] = [];
const ComposerMentionsContext = createContext<ComposerMentions | undefined>(undefined);

function skillListsEqual(
  current: readonly InvocableSkillEntry[],
  next: readonly InvocableSkillEntry[],
): boolean {
  return current.length === next.length && current.every((skill, index) => {
    const other = next[index];
    return (
      other?.ref === skill.ref &&
      other?.id === skill.id &&
      other?.name === skill.name &&
      other?.description === skill.description
    );
  });
}

function conversationSessionListsEqual(
  current: readonly ConversationSession[],
  next: readonly ConversationSession[],
): boolean {
  if (current.length !== next.length) return false;
  return current.every((session, index) => {
    const other = next[index];
    return (
      other !== undefined &&
      session.id === other.id &&
      session.runtimeHostId === other.runtimeHostId &&
      session.name === other.name &&
      session.status === other.status &&
      session.lastMessageAt === other.lastMessageAt &&
      session.lastMessagePreview === other.lastMessagePreview &&
      session.isArchived === other.isArchived &&
      session.shared === other.shared
    );
  });
}

function useConversationMentions(surface: ComposerMentionsSurface): ComposerMentions {
  const services = useConversationServices();
  const locale = useUiLocale();
  const mentionCopy = getConversationCopy(locale).mentions;
  const [catalog, setCatalog] = useState<{
    contextKey: string;
    loading: boolean;
    settled?: 'empty' | 'populated';
    skills: InvocableSkillEntry[];
  }>({
    contextKey: '',
    loading: true,
    skills: EMPTY_SKILLS,
  });
  const [sessions, setSessions] = useState<readonly ConversationSession[]>([]);
  const contextKey = surface.sessionId ? `session\u0000${surface.sessionId}` : [
    surface.sessionId ?? '',
    surface.projectPath ?? '',
    surface.newSessionModel?.llmConnectionSlug ?? '',
    surface.newSessionModel?.model ?? '',
    surface.newSessionCollaborationMode ?? 'agent',
    surface.newSessionPermissionMode ?? '',
    surface.newTaskTarget?.profileId ?? '',
    surface.newTaskTarget?.hostId ?? '',
    surface.newTaskTarget?.projectId ?? '',
  ].join('\u0000');
  const liveCatalog = catalog.contextKey === contextKey
    ? catalog
    : { contextKey, loading: true, settled: undefined, skills: EMPTY_SKILLS };
  const activeHostId = surface.sessionId
    ? sessions.find((session) => session.id === surface.sessionId)?.runtimeHostId
    : surface.newTaskTarget?.hostId;

  useEffect(() => {
    let cancelled = false;
    const refreshSessions = () => {
      void services.sessions.list().then((next) => {
        if (!cancelled) {
          setSessions((previous) =>
            conversationSessionListsEqual(previous, next) ? previous : next,
          );
        }
      }).catch(() => {
        if (!cancelled) {
          setSessions((previous) => (previous.length === 0 ? previous : []));
        }
      });
    };
    refreshSessions();
    const unsubscribe = services.sessions.subscribeChanges(refreshSessions);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [services]);

  useEffect(() => {
    let cancelled = false;
    let requestVersion = 0;
    const context = {
      ...(surface.newSessionModel ?? {}),
      collaborationMode: surface.newSessionCollaborationMode ?? 'agent',
      ...(surface.newSessionPermissionMode
        ? { permissionMode: surface.newSessionPermissionMode }
        : {}),
    };
    const refresh = () => {
      const version = ++requestVersion;
      const request = surface.sessionId
        ? services.skills.listInvocable(surface.sessionId)
        : surface.newTaskTarget
          ? services.newTasks.listInvocableSkills(surface.newTaskTarget, context)
          : Promise.resolve<readonly InvocableSkillEntry[]>([]);
      setCatalog((previous) =>
        previous.contextKey === contextKey
          ? { ...previous, loading: true }
          : { contextKey, loading: true, settled: undefined, skills: EMPTY_SKILLS },
      );
      void request.then((next) => {
        if (cancelled || version !== requestVersion) return;
        setCatalog((previous) => ({
          contextKey,
          loading: false,
          settled: next.length === 0 ? 'empty' : 'populated',
          skills:
            previous.contextKey === contextKey && skillListsEqual(previous.skills, next)
              ? previous.skills
              : [...next],
        }));
      }).catch(() => {
        if (!cancelled && version === requestVersion) {
          setCatalog({ contextKey, loading: false, settled: 'empty', skills: EMPTY_SKILLS });
        }
      });
    };
    refresh();
    const unsubscribeContext = surface.sessionId
      ? services.mcp.subscribeChanges(refresh)
      : services.newTasks.subscribeChanges(refresh);
    const unsubscribeSession = surface.sessionId
      ? services.sessions.subscribeChanges((event) => {
          if (
            event.sessionId === surface.sessionId &&
            (event.reason === 'updated' ||
              event.reason === 'mode-change' ||
              event.reason === 'turn-status-change' ||
              event.reason === 'rebound')
          ) {
            refresh();
          }
        })
      : () => undefined;
    return () => {
      cancelled = true;
      requestVersion += 1;
      unsubscribeContext();
      unsubscribeSession();
    };
  }, [
    contextKey,
    services,
    surface.sessionId ? undefined : surface.newSessionModel?.llmConnectionSlug,
    surface.sessionId ? undefined : surface.newSessionModel?.model,
    surface.sessionId ? undefined : surface.newSessionCollaborationMode,
    surface.sessionId ? undefined : surface.newSessionPermissionMode,
    surface.sessionId,
    surface.skillCatalogRevision,
    surface.sessionId ? undefined : surface.newTaskTarget?.profileId,
    surface.sessionId ? undefined : surface.newTaskTarget?.hostId,
    surface.sessionId ? undefined : surface.newTaskTarget?.projectId,
  ]);

  const searchMentionFiles = useMemo(
    () => async (query: string): Promise<ReadonlyArray<{ relativePath: string }>> => {
      try {
        const result = surface.sessionId
          ? await services.workspace.searchFiles(query, { sessionId: surface.sessionId })
          : surface.newTaskTarget
            ? await services.newTasks.searchFiles(surface.newTaskTarget, query)
            : { ok: false as const, reason: 'no_project' as const };
        return result.ok ? result.files : [];
      } catch {
        return [];
      }
    },
    [
      services,
      surface.newTaskTarget?.profileId,
      surface.newTaskTarget?.hostId,
      surface.newTaskTarget?.projectId,
      surface.sessionId,
    ],
  );

  const reference = useSessionReferenceComposer({
    sessions,
    activeId: surface.sessionId,
    hostId: activeHostId,
    addQuote: surface.onAddQuote,
    pendingQuotes: surface.pendingQuotes,
    errorCopy: useMemo(
      () => ({
        unavailableTitle: mentionCopy.sessionReferenceUnavailableTitle,
        unavailableDetail: mentionCopy.sessionReferenceUnavailableDetail,
        emptyTitle: mentionCopy.sessionReferenceEmptyTitle,
        emptyDetail: mentionCopy.sessionReferenceEmptyDetail,
        readFailedTitle: mentionCopy.sessionReferenceReadFailedTitle,
        readFailedDetail: mentionCopy.sessionReferenceReadFailedDetail,
        limitDetail: mentionCopy.sessionReferenceLimitDetail,
      }),
      [
        mentionCopy.sessionReferenceEmptyDetail,
        mentionCopy.sessionReferenceEmptyTitle,
        mentionCopy.sessionReferenceReadFailedDetail,
        mentionCopy.sessionReferenceLimitDetail,
        mentionCopy.sessionReferenceReadFailedTitle,
        mentionCopy.sessionReferenceUnavailableDetail,
        mentionCopy.sessionReferenceUnavailableTitle,
      ],
    ),
  });
  const referenceEnabled = surface.sessionId !== undefined || surface.newTaskTarget !== undefined;
  return useMemo(() => ({
    mentionSkills: liveCatalog.skills,
    mentionSkillsUnavailable: liveCatalog.settled === 'empty',
    mentionSkillsLoading: liveCatalog.loading,
    searchMentionFiles,
    sessionReferences: surface.onAddQuote && referenceEnabled ? reference.references : [],
    onPickSessionReference:
      surface.onAddQuote && referenceEnabled ? reference.pick : undefined,
    pendingSessionReferences: reference.pendingReferences,
    onRemovePendingSessionReference: reference.removePendingReference,
    sessionReferenceError: reference.error,
    waitForSessionReference: reference.waitForPending,
  }), [
    liveCatalog.loading,
    liveCatalog.settled,
    liveCatalog.skills,
    reference.error,
    reference.pick,
    reference.pendingReferences,
    reference.removePendingReference,
    reference.references,
    reference.waitForPending,
    searchMentionFiles,
    surface.onAddQuote,
  ]);
}

export function ComposerMentionsProvider(props: ComposerMentionsSurface & { readonly children: ReactNode }) {
  const mentions = useConversationMentions(props);
  return <ComposerMentionsContext.Provider value={mentions}>{props.children}</ComposerMentionsContext.Provider>;
}

export function useComposerMentionsContext(): ComposerMentions | undefined {
  return useContext(ComposerMentionsContext);
}
