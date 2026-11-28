import { createNsMetry } from './nsmetry/index';
import { currentVersion } from './versions';

/** The host whose visits count; local builds and previews send nothing. */
export const ANALYTICS_HOST = 'nsh.dev';

/**
 * The path a page view is counted under: no query or hash (they can carry
 * search text), no trailing slash, so `/docs/` and `/docs` are one page.
 */
export function pagePath(pathname: string): string {
  return pathname.replace(/\/+$/, '') || '/';
}

/**
 * Counts this page view with NsMetry: one anonymous id per browser in
 * localStorage (`nsmetry.uid`), no cookies. Events wait in memory and go out
 * in one request when the page is hidden or left, or after 30 seconds.
 */
export function startAnalytics(): void {
  if (location.hostname !== ANALYTICS_HOST) return;
  const nsmetry = createNsMetry({
    endpoint: 'https://nsmetry.huacnlee-account.workers.dev',
    site: 'nsh.dev',
    // The docs version this build serves (`v0.7.1`, `main`).
    appVersion: currentVersion,
    persistUserId: true,
    flushInterval: 30_000,
  });
  nsmetry.screen(pagePath(location.pathname));
}
