import type { SessionSummary, StoredMessage } from '@maka/core/session';

export type SessionReadBoundaries = Record<string, number>;

export interface SessionListRefresher {
  refresh(): Promise<SessionSummary[]>;
}

export interface SessionListRefresherOptions {
  listSessions: () => Promise<SessionSummary[]>;
  readBoundaries: () => Readonly<SessionReadBoundaries>;
  currentSessions: () => SessionSummary[];
  commitSessions: (sessions: SessionSummary[]) => void;
  onError: (error: unknown) => void;
}

export function rememberSessionReadBoundary(
  boundaries: SessionReadBoundaries,
  sessionId: string,
  messages: readonly StoredMessage[],
): void {
  const boundary = latestMessageTs(messages);
  if (boundary === undefined) return;
  boundaries[sessionId] = Math.max(boundaries[sessionId] ?? 0, boundary);
}

export function applySessionReadOverrides(
  sessions: SessionSummary[],
  boundaries: Readonly<SessionReadBoundaries>,
): SessionSummary[] {
  let changed = false;
  const next = sessions.map((session) => {
    const boundary = boundaries[session.id];
    if (boundary === undefined || !session.hasUnread) return session;
    if ((session.lastMessageAt ?? 0) > boundary) return session;
    changed = true;
    return { ...session, hasUnread: false };
  });
  return changed ? next : sessions;
}

export function applyLocalSessionRead(
  boundaries: SessionReadBoundaries,
  sessions: SessionSummary[],
  sessionId: string,
  readMessages: readonly StoredMessage[],
): SessionSummary[] {
  rememberSessionReadBoundary(boundaries, sessionId, readMessages);
  return applySessionReadOverrides(sessions, boundaries);
}

export function createSessionListRefresher(options: SessionListRefresherOptions): SessionListRefresher {
  let requestedGeneration = 0;
  let completedGeneration = 0;
  let activeRefresh: Promise<SessionSummary[]> | undefined;

  const drainRefreshes = async (): Promise<SessionSummary[]> => {
    let result = options.currentSessions();
    while (completedGeneration < requestedGeneration) {
      // Session events can arrive in bursts (especially while spawning a swarm). Keep one
      // list IPC in flight and collapse everything that arrived during it into one trailing read.
      const generation = requestedGeneration;
      try {
        const listed = await options.listSessions();
        if (generation === requestedGeneration) {
          result = applySessionReadOverrides(listed, options.readBoundaries());
          options.commitSessions(result);
        } else {
          result = options.currentSessions();
        }
      } catch (error) {
        if (generation === requestedGeneration) options.onError(error);
        result = options.currentSessions();
      }
      completedGeneration = generation;
    }
    return result;
  };

  return {
    refresh(): Promise<SessionSummary[]> {
      requestedGeneration += 1;
      if (!activeRefresh) {
        activeRefresh = drainRefreshes().finally(() => {
          activeRefresh = undefined;
        });
      }
      return activeRefresh;
    },
  };
}

function latestMessageTs(messages: readonly StoredMessage[]): number | undefined {
  let latest: number | undefined;
  for (const message of messages) {
    if (!Number.isFinite(message.ts)) continue;
    latest = latest === undefined ? message.ts : Math.max(latest, message.ts);
  }
  return latest;
}
