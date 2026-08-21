import type { SessionSendProjection } from '@maka/core/session-send-projection';

export interface StaleSessionsInput {
  /** Sessions visible in the sidebar (already filtered + grouped). */
  sessions: ReadonlyArray<{
    id: string;
  }>;
  /** Readiness already resolved by each Session's owning Runtime Host. */
  sendOutcomes: Readonly<Record<string, SessionSendProjection>>;
}

export function deriveStaleSessionIds(input: StaleSessionsInput): Set<string> {
  const stale = new Set<string>();
  for (const session of input.sessions) {
    if (isStale(input.sendOutcomes[session.id])) {
      stale.add(session.id);
    }
  }
  return stale;
}

/**
 * A row is stale when its owning Runtime Host says the next send cannot go
 * anywhere the user can fix from the rail.
 *
 * `fake_backend` is read from the projection rather than from `session.backend`
 * (#3211): the readiness projection is the single authority on whether a task
 * is usable, and a retired backend is one of its answers like any other.
 *
 * `provider_retired` belongs with them for the same reason and one more: the
 * connection is still there and still enabled, so nothing else about the row
 * looks wrong. Without this the task reads as healthy until it is opened, and
 * the only fix — pointing it at another connection — is not one the rail can
 * suggest for a task it never marked.
 */
function isStale(outcome: SessionSendProjection | undefined): boolean {
  if (outcome?.kind !== 'blocked') return false;
  return (
    outcome.reason === 'connection_missing' ||
    outcome.reason === 'fake_backend' ||
    outcome.reason === 'provider_retired'
  );
}
