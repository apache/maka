import type { SessionSendProjection } from '@maka/core/session-send-projection';

export interface StaleSessionsInput {
  /** Sessions visible in the sidebar (already filtered + grouped). */
  sessions: ReadonlyArray<{
    id: string;
    backend: string;
  }>;
  /** Readiness already resolved by each Session's owning Runtime Host. */
  sendOutcomes: Readonly<Record<string, SessionSendProjection>>;
}

export function deriveStaleSessionIds(input: StaleSessionsInput): Set<string> {
  const stale = new Set<string>();
  for (const session of input.sessions) {
    if (isStale(session, input.sendOutcomes[session.id])) {
      stale.add(session.id);
    }
  }
  return stale;
}

function isStale(
  session: { backend: string },
  outcome: SessionSendProjection | undefined,
): boolean {
  if (session.backend === 'fake') return true;
  return outcome?.kind === 'blocked' && outcome.reason === 'connection_missing';
}
