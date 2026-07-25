import { safeLocalStorageGet } from './browser-storage.js';

export const SESSION_LIST_EXPANDED_DEFAULT_WIDTH = 210;
export const SESSION_LIST_EXPANDED_MIN_WIDTH = 210;
export const SESSION_LIST_EXPANDED_MAX_WIDTH = 280;

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
