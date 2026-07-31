export type CompanionForkVisibilityEvent =
  | { type: 'fork-created'; sessionId: string }
  | { type: 'cleanup-succeeded'; sessionId: string };

/**
 * The renderer owns transient companion visibility, while the main process owns
 * deletion. Keep every created fork hidden until that authority confirms cleanup
 * or a later authoritative session list no longer contains it.
 */
export function applyCompanionForkVisibilityEvent(
  current: ReadonlySet<string>,
  event: CompanionForkVisibilityEvent,
): ReadonlySet<string> {
  if (event.type === 'fork-created') {
    if (current.has(event.sessionId)) return current;
    return new Set([...current, event.sessionId]);
  }
  if (!current.has(event.sessionId)) return current;
  const next = new Set(current);
  next.delete(event.sessionId);
  return next;
}

export function reconcileCompanionForkVisibility(
  current: ReadonlySet<string>,
  authoritativeSessionIds: ReadonlySet<string>,
): ReadonlySet<string> {
  if (current.size === 0) return current;
  const next = new Set([...current].filter((id) => authoritativeSessionIds.has(id)));
  return next.size === current.size ? current : next;
}
