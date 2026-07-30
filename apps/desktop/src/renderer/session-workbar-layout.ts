import { safeLocalStorageGet } from './browser-storage.js';

export const SESSION_WORKBAR_DEFAULT_WIDTH = 400;
export const SESSION_WORKBAR_MIN_WIDTH = 320;
export const SESSION_WORKBAR_MAX_WIDTH = 600;
// 'quote' is a transient tab that only exists while a quote side-panel excerpt
// is active; it is never persisted as a default (see readSessionWorkbarTab).
export type SessionWorkbarTab = 'tasks' | 'browser' | 'files' | 'quote';

export function clampSessionWorkbarWidth(value: number): number {
  return Math.round(Math.min(SESSION_WORKBAR_MAX_WIDTH, Math.max(SESSION_WORKBAR_MIN_WIDTH, value)));
}

export function readSessionWorkbarWidth(): number {
  const stored = Number(safeLocalStorageGet('maka-session-workbar-width-v1'));
  return Number.isFinite(stored) && stored > 0
    ? clampSessionWorkbarWidth(stored)
    : SESSION_WORKBAR_DEFAULT_WIDTH;
}

export function readSessionWorkbarCollapsed(): boolean {
  const stored = safeLocalStorageGet('maka-session-workbar-collapsed-v1');
  if (stored === 'false') return false;
  if (stored === 'true') return true;
  return true;
}

export function readSessionWorkbarTab(): SessionWorkbarTab {
  const stored = safeLocalStorageGet('maka-session-workbar-tab-v1');
  return stored === 'browser' || stored === 'files' ? stored : 'tasks';
}
