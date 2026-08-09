export interface MessageRefreshTicket {
  sessionId: string;
  ordinal: number;
}

/**
 * Prevents an older asynchronous transcript read from replacing a snapshot
 * returned by a newer read. Failed reads never advance the watermark, so an
 * older successful read may still recover the UI when every newer read fails.
 */
export function createMessageRefreshOrder(): {
  begin(sessionId: string): MessageRefreshTicket;
  acceptSuccessful(ticket: MessageRefreshTicket): boolean;
} {
  let nextOrdinal = 0;
  const latestSuccessfulBySession = new Map<string, number>();

  return {
    begin(sessionId) {
      nextOrdinal += 1;
      return { sessionId, ordinal: nextOrdinal };
    },
    acceptSuccessful(ticket) {
      const latest = latestSuccessfulBySession.get(ticket.sessionId) ?? 0;
      if (ticket.ordinal < latest) return false;
      latestSuccessfulBySession.set(ticket.sessionId, ticket.ordinal);
      return true;
    },
  };
}
