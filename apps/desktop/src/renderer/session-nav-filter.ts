import type { SessionSummary } from '@maka/core/session';

/**
 * Which sessions the rail lists. Archived tasks are managed in Settings › 活动 ›
 * 已归档任务 (#2985), so the rail shows everything else.
 *
 * This used to switch on `NavSelection.filter`. That filter is gone (#2984): its
 * last two values were a destination that moved to Settings and a value nothing
 * ever selected, which left one branch reachable — this one.
 */
export function sessionMatchesRail(session: SessionSummary): boolean {
  return !session.isArchived;
}
