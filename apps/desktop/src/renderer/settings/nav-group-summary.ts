/**
 * Settings nav-group enum + presentation order for the Settings modal
 * sidebar.
 *
 * The `deriveNavGroupSummary` helper that used to live here (the short
 * status line under each group label, PR-HEALTH-1) lost its last consumer
 * when the nav was regrouped (PR-SETTINGS-NAV-REGROUP-0) and was removed
 * as dead code — restore from git history if group summaries come back.
 */

export type SettingsNavGroup = 'preferences' | 'capabilities' | 'activity' | 'system';

/**
 * The render order used by the Settings modal sidebar. Lives here so the
 * nav-group enum and its presentation order stay in one place.
 */
export const NAV_GROUP_ORDER: SettingsNavGroup[] = [
  'preferences',
  'capabilities',
  'activity',
  'system',
];
