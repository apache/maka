export interface PendingSteeringDisposition {
  readonly sessionId: string;
  admitted: boolean;
  turnCompleted: boolean;
}

export type PendingSteeringDispositionStore = Map<string, PendingSteeringDisposition>;

export function registerPendingSteering(
  store: PendingSteeringDispositionStore,
  messageId: string,
  sessionId: string,
): void {
  store.set(messageId, { sessionId, admitted: false, turnCompleted: false });
}

/**
 * Mark Host admission complete. A true result means the old turn completed
 * while admission was in flight, so the caller can now report authoritative
 * next-turn deferral.
 */
export function admitPendingSteering(
  store: PendingSteeringDispositionStore,
  messageId: string,
): boolean {
  const pending = store.get(messageId);
  if (!pending) return false;
  if (pending.turnCompleted) {
    store.delete(messageId);
    return true;
  }
  pending.admitted = true;
  return false;
}

/** A steering_message with this id proves that Runtime consumed it this turn. */
export function consumePendingSteering(
  store: PendingSteeringDispositionStore,
  messageId: string,
): void {
  store.delete(messageId);
}

/**
 * Record the terminal boundary. Admitted messages still in the store were not
 * consumed by a step boundary and are therefore Host-owned follow-up input.
 */
export function completePendingSteeringTurn(
  store: PendingSteeringDispositionStore,
  sessionId: string,
): boolean {
  let deferred = false;
  for (const [messageId, pending] of store) {
    if (pending.sessionId !== sessionId) continue;
    if (pending.admitted) {
      store.delete(messageId);
      deferred = true;
    } else {
      pending.turnCompleted = true;
    }
  }
  return deferred;
}

export function abandonPendingSteering(
  store: PendingSteeringDispositionStore,
  messageId: string,
): void {
  store.delete(messageId);
}

export function abandonPendingSteeringSession(
  store: PendingSteeringDispositionStore,
  sessionId: string,
): void {
  for (const [messageId, pending] of store) {
    if (pending.sessionId === sessionId) store.delete(messageId);
  }
}
