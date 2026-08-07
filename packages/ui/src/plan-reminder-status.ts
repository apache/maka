import type { PlanReminder, PlanReminderStatus } from '@maka/core';
import { dotForStatus, type StatusSemantic } from './status-vocabulary.js';

/**
 * Lifecycle meaning for a reminder itself: paused is the only state that asks
 * for attention, completed is spent, everything else is simply live.
 *
 * Shared by the list page and the inspector so one reminder never reads as two
 * different severities depending on where it is shown. Says what the state
 * MEANS and lets status-vocabulary decide the colour — the domain judgement
 * (that paused deserves attention) is this file's, the palette is not.
 */
export function planReminderStatusSemantic(status: PlanReminderStatus): StatusSemantic {
  if (status === 'paused') return 'attention';
  if (status === 'completed') return 'neutral';
  return 'active';
}

export function planReminderStatusDotVariant(status: PlanReminderStatus) {
  return dotForStatus(planReminderStatusSemantic(status));
}

/**
 * Run-history meaning. `triggered` = it fired, which is a record rather than a
 * health signal, so it reads as `active` and never earns success-green;
 * `blocked` = intentionally skipped, which asks for attention; `failed` = a
 * delivery error. Exception-only by design.
 */
export function planRunStatusSemantic(
  status: NonNullable<PlanReminder['lastRun']>['status'],
): StatusSemantic {
  if (status === 'blocked') return 'attention';
  if (status === 'failed') return 'error';
  return 'active';
}

export function planRunStatusDotVariant(status: NonNullable<PlanReminder['lastRun']>['status']) {
  return dotForStatus(planRunStatusSemantic(status));
}
