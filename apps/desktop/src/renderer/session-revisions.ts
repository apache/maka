import { sessionRevisionFamilyId, visibleSessionRevisionMembers } from '@maka/core/session-revisions';

import { type SessionSummary } from '@maka/core/session';

export interface SessionRevisionNavigation {
  current: number;
  total: number;
  previousSessionId?: string;
  nextSessionId?: string;
}

/** Build deterministic old/new version navigation for the active conversation. */
export function deriveSessionRevisionNavigation(
  sessions: readonly SessionSummary[],
  activeId: string | undefined,
): SessionRevisionNavigation | undefined {
  if (!activeId) return undefined;
  const active = sessions.find((session) => session.id === activeId);
  if (!active) return undefined;
  const root = sessionRevisionFamilyId(active);
  const rawFamily = sessions.filter((session) => sessionRevisionFamilyId(session) === root);
  const family = visibleSessionRevisionMembers(rawFamily, activeId);
  if (family.length <= 1) return undefined;
  const ordered = [...family].sort((left, right) => {
    const indexDelta = (left.revisionIndex ?? 1) - (right.revisionIndex ?? 1);
    return indexDelta !== 0 ? indexDelta : left.id.localeCompare(right.id);
  });
  const index = ordered.findIndex((session) => session.id === activeId);
  if (index < 0) return undefined;
  return {
    current: index + 1,
    total: ordered.length,
    ...(ordered[index - 1] ? { previousSessionId: ordered[index - 1]!.id } : {}),
    ...(ordered[index + 1] ? { nextSessionId: ordered[index + 1]!.id } : {}),
  };
}
