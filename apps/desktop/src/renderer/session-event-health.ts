import type { SessionEventStreamSnapshot } from '@maka/core/session-event-health';
import type { SessionStatus } from '@maka/core/session';
import { isInFlightToolStatus } from '@maka/core/tool-result-status';
import type { ToolActivityItem } from '@maka/ui';
import {
  deriveSessionEventStreamStatus,
  sessionExpectsEventStream,
  shouldRefreshStaleSessionEventStream,
} from '@maka/core/session-event-health';

export function createSessionEventStreamSubscription(input: {
  sessionId: string;
  now: number;
}): SessionEventStreamSnapshot {
  return {
    sessionId: input.sessionId,
    status: 'connected',
    subscribedAt: input.now,
    checkedAt: input.now,
  };
}

export function recordSessionEventStreamEvent(
  previous: SessionEventStreamSnapshot,
  now: number,
): SessionEventStreamSnapshot {
  return {
    ...previous,
    status: previous.status === 'stale' ? 'recovered' : 'connected',
    checkedAt: now,
    lastEventAt: now,
    staleSince: undefined,
  };
}

export function recordSessionEventStreamChange(
  previous: SessionEventStreamSnapshot,
  now: number,
): SessionEventStreamSnapshot {
  return {
    ...previous,
    status: previous.status === 'stale' ? 'recovered' : previous.status === 'closed' ? 'connected' : previous.status,
    checkedAt: now,
    lastChangedAt: now,
    staleSince: undefined,
  };
}

export function evaluateSessionEventStreamSnapshot(input: {
  previous: SessionEventStreamSnapshot | undefined;
  now: number;
  sessionStatus: SessionStatus | undefined;
  hasLiveActivity: boolean;
}): { snapshot: SessionEventStreamSnapshot | undefined; shouldRefresh: boolean } {
  const previous = input.previous;
  if (!previous) return { snapshot: undefined, shouldRefresh: false };

  const expected = sessionExpectsEventStream(input.sessionStatus, input.hasLiveActivity);
  const status = deriveSessionEventStreamStatus({
    now: input.now,
    subscribedAt: previous.subscribedAt,
    lastEventAt: previous.lastEventAt,
    lastChangedAt: previous.lastChangedAt,
    previousStatus: previous.status,
    expected,
  });
  const refreshDue = shouldRefreshStaleSessionEventStream({
    status,
    now: input.now,
    refreshRequestedAt: previous.refreshRequestedAt,
  });

  return {
    snapshot: {
      ...previous,
      status,
      checkedAt: input.now,
      staleSince: status === 'stale' ? previous.staleSince ?? input.now : undefined,
      refreshRequestedAt: refreshDue ? input.now : previous.refreshRequestedAt,
    },
    shouldRefresh: refreshDue,
  };
}

export function hasInFlightToolActivity(
  liveTools: readonly Pick<ToolActivityItem, 'status'>[],
): boolean {
  return liveTools.some((tool) => isInFlightToolStatus(tool.status));
}
