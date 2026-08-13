import type { TurnRecord } from '@maka/core/session';
import {
  mergeSessionTurnContributions,
  projectSessionTurnContribution,
  type SessionTurnContribution,
} from '@maka/runtime-host/protocol';

export async function listDesktopSessionTurns(sessionId: string): Promise<TurnRecord[]> {
  const contributions = new Map<string, SessionTurnContribution>();
  const positions = new Set<number>();
  let throughSequence: number | null = null;
  let position = 0;
  while (true) {
    if (positions.has(position)) throw new Error('Session turn query repeated a position');
    positions.add(position);
    const page = await window.maka.sessions.queryTurnContributions(
      sessionId,
      throughSequence,
      position,
    );
    throughSequence = page.throughSequence;
    for (const contribution of page.contributions) {
      const current = contributions.get(contribution.turnId);
      contributions.set(
        contribution.turnId,
        current
          ? mergeSessionTurnContributions(current, contribution)
          : contribution,
      );
    }
    if (page.nextPosition === null) break;
    if (page.nextPosition <= position) throw new Error('Session turn query did not advance');
    position = page.nextPosition;
  }
  return [...contributions.values()]
    .sort((left, right) => left.firstSequence - right.firstSequence)
    .map(projectSessionTurnContribution);
}

export function desktopSessionsWithTurnIndex() {
  return { ...window.maka.sessions, listTurns: listDesktopSessionTurns };
}
