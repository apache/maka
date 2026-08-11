import { useCallback, useEffect, useState } from 'react';
import type { ChatDefaultPermissionMode } from '@maka/core/settings';
import type { SkillEntry } from '@maka/ui';
import type { InvocableSkillEntry } from '@maka/runtime/skill-invocation';

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
    // Fail closed only on a key change (this effect re-running): the previous
    // session/project's Skills must not stay visible while the authoritative
    // projection reloads. A same-key refresh keeps the current list on screen
    // instead. Clearing on those too is what made an open `/` menu alternate
    // between its commands-only and commands-plus-skills geometries on every
    // session or MCP event (#2667); the stale window is one IPC round trip,
    // and a Skill withdrawn inside it still fails safely, because selection
    // resolves through the Runtime resolver that no longer knows it.
    const refresh = (options?: { failClosed?: boolean }) => {
      const version = ++requestVersion;
      if (options?.failClosed) setMentionSkills([]);
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
          if (cancelled || version !== requestVersion) return;
          // A refresh that changed nothing keeps the previous array identity,
          // so the composer's trigger memo and menu-replay effect stay quiet.
          setMentionSkills((current) =>
            invocableSkillListsEqual(current, next) ? current : [...next],
          );
        },
        () => {
          // Fail soft: an unavailable projection leaves `/` with no suggestions.
          // Direct `/skill:<id>` input still reaches the same Runtime resolver.
        },
      );
    };
    refresh({ failClosed: true });
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
