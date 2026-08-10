import type { MessageQueueEntryProjection } from '@maka/core';
import type { MessageQueueUiState } from './app-shell-session-ui-state.js';

export function addOptimisticQueuedMessage(
  current: Record<string, MessageQueueUiState>,
  sessionId: string,
  entry: MessageQueueEntryProjection,
): Record<string, MessageQueueUiState> {
  const existing = current[sessionId] ?? {
    paused: false,
    steering: [],
    followup: [],
  };
  const pendingEntryIds = new Set(existing.pendingEntryIds);
  pendingEntryIds.add(entry.entryId);
  const key = entry.placement === 'current_turn' ? 'steering' : 'followup';
  return {
    ...current,
    [sessionId]: {
      ...existing,
      [key]: [...existing[key], entry],
      pendingEntryIds,
    },
  };
}

export function removeOptimisticQueuedMessage(
  current: Record<string, MessageQueueUiState>,
  sessionId: string,
  entryId: string,
): Record<string, MessageQueueUiState> {
  const existing = current[sessionId];
  if (!existing?.pendingEntryIds?.has(entryId)) return current;
  const pendingEntryIds = new Set(existing.pendingEntryIds);
  pendingEntryIds.delete(entryId);
  const steering = existing.steering.filter((entry) => entry.entryId !== entryId);
  const followup = existing.followup.filter((entry) => entry.entryId !== entryId);
  if (steering.length === 0 && followup.length === 0) {
    const next = { ...current };
    delete next[sessionId];
    return next;
  }
  return {
    ...current,
    [sessionId]: {
      ...existing,
      steering,
      followup,
      ...(pendingEntryIds.size > 0 ? { pendingEntryIds } : { pendingEntryIds: undefined }),
    },
  };
}
