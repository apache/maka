export interface AppUpdateActivitySources {
  sessionActivities: { hasActive(): boolean };
  automationScheduler: { hasInFlight(): boolean };
  shellRuns: { liveCount(): number };
}

/**
 * Reports work that the app shutdown path would interrupt.
 *
 * Keep the complete source list here so updater consent cannot silently drift
 * from the independently owned session, Automation, and shell lifecycles.
 */
export function hasInterruptibleUpdateWork(sources: AppUpdateActivitySources): boolean {
  return sources.sessionActivities.hasActive() ||
    sources.automationScheduler.hasInFlight() ||
    sources.shellRuns.liveCount() > 0;
}
