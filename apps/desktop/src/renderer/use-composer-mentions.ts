import { useCallback, useEffect, useState } from 'react';
import type { ChatDefaultPermissionMode } from '@maka/core/settings';
import type { SkillEntry } from '@maka/ui';
import type { InvocableSkillEntry } from '@maka/runtime/skill-invocation';

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
      void window.maka.skills.listInvocable(
        sessionId,
        sessionId
          ? undefined
          : {
              ...(newSessionModel ?? {}),
              collaborationMode: newSessionCollaborationMode ?? 'agent',
            },
      ).then(
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
    const unsubscribeMcp = window.maka.mcp.subscribeChanges(() => refresh());
    return () => {
      cancelled = true;
      requestVersion += 1;
      unsubscribeSessions();
      unsubscribeMcp();
    };
  }, [
    projectPath,
    sessionId,
    skills,
    newSessionModel?.llmConnectionSlug,
    newSessionModel?.model,
    newSessionCollaborationMode,
    newSessionPermissionMode,
  ]);

  const searchMentionFiles = useCallback(
    async (query: string): Promise<ReadonlyArray<{ relativePath: string }>> => {
      try {
        const result = await window.maka.workspace.searchFiles(query, { sessionId });
        return result.ok ? result.files : [];
      } catch {
        // Fail soft: a failed search just yields an empty list, so the popup
        // shows 未找到文件 rather than surfacing an error into the composer.
        return [];
      }
    },
    [sessionId],
  );

  return { mentionSkills, searchMentionFiles };
}
