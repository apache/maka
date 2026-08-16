import type { SessionViewMode } from '@maka/ui';
import { safeLocalStorageGet, safeLocalStorageSet } from './browser-storage.js';

export const SESSION_LIST_EXPANDED_DEFAULT_WIDTH = 260;
export const SESSION_LIST_EXPANDED_MIN_WIDTH = 180;
export const SESSION_LIST_EXPANDED_MAX_WIDTH = 480;

const SESSION_LIST_VIEW_MODE_KEY = 'maka-chat-list-view-mode-v1';

export function readSessionListViewMode(): SessionViewMode {
  const stored = safeLocalStorageGet(SESSION_LIST_VIEW_MODE_KEY);
  if (stored === 'project' || stored === 'conversation') return stored;
  return 'conversation';
}

export function writeSessionListViewMode(mode: SessionViewMode): void {
  safeLocalStorageSet(SESSION_LIST_VIEW_MODE_KEY, mode);
}

export function readSessionListWidth(): number {
  const stored = Number(safeLocalStorageGet('maka-chat-list-width-v1'));
  if (Number.isFinite(stored) && stored > 0) return clampSessionListWidth(stored);
  return SESSION_LIST_EXPANDED_DEFAULT_WIDTH;
}

export function readSessionListCollapsed(): boolean {
  const stored = safeLocalStorageGet('maka-chat-list-collapsed-v1');
  if (stored === 'false') return false;
  if (stored === 'true') return true;
  return true;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function clampSessionListWidth(value: number): number {
  return Math.round(clamp(value, SESSION_LIST_EXPANDED_MIN_WIDTH, SESSION_LIST_EXPANDED_MAX_WIDTH));
}
