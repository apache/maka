import type { WorkHubSnapshot, WorkHubWorkBlock } from '@maka/core/workhub';
import type { RunNotificationInput, RunNotificationKind } from '../notifications-policy.js';

/**
 * Derives low-noise lifecycle notifications from durable Work transitions.
 * Initial hydration and repeated progress events intentionally emit nothing.
 */
export function projectWorkHubLifecycleNotifications(
  previous: WorkHubSnapshot,
  next: WorkHubSnapshot,
): RunNotificationInput[] {
  const before = new Map(
    previous.items
      .filter((item): item is WorkHubWorkBlock => item.kind === 'work')
      .map((item) => [item.id, item]),
  );
  const notifications: RunNotificationInput[] = [];
  for (const item of next.items) {
    if (item.kind !== 'work') continue;
    const prior = before.get(item.id);
    if (!prior || prior.status === item.status) continue;
    const kind = notificationKind(prior.status, item.status);
    if (!kind) continue;
    notifications.push({
      kind,
      title: `${item.projectName} / ${item.workName}`,
      ...(item.detail ? { body: item.detail } : {}),
    });
  }
  return notifications;
}

function notificationKind(
  previous: WorkHubWorkBlock['status'],
  next: WorkHubWorkBlock['status'],
): RunNotificationKind | undefined {
  if (previous !== 'running' && previous !== 'waiting_for_user') return undefined;
  if (next === 'waiting_for_user') return 'waiting_for_user';
  if (next === 'completed') return 'completed';
  if (next === 'failed') return 'errored';
  return undefined;
}
