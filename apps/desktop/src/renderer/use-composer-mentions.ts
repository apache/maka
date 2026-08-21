import { useCallback, useEffect, useState } from 'react';
import type { ChatDefaultPermissionMode } from '@maka/core/settings';
import type { SkillEntry } from '@maka/ui';
import type { InvocableSkillEntry } from '@maka/runtime/skill-invocation';
import type { DesktopNewTaskTarget } from '../preload/bridge-contract.js';

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
  const [mentionSkills, setMentionSkills] = useState<InvocableSkillEntry[]>([]);

  useEffect(() => {
    let cancelled = false;
    let requestVersion = 0;
    // Do not briefly advertise the previous session/project's Skills while the
    // authoritative projection is being refreshed. The same fail-closed reset
    // applies when a model/mode/plan or MCP event changes the backend surface:
    // a visible popup must never retain a now-unavailable Skill.
    const refresh = () => {
      const version = ++requestVersion;
      setMentionSkills([]);
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
          if (!cancelled && version === requestVersion) setMentionSkills(next);
        },
        () => {
          // Fail soft: an unavailable projection leaves `/` with no suggestions.
          // Direct `/skill:<id>` input still reaches the same Runtime resolver.
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

  return { mentionSkills, searchMentionFiles };
}
