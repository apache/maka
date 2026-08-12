/**
 * Renderer-side helpers for the structured `app:openPath` IPC contract.
 *
 * Backend (see `apps/desktop/src/main/open-path-guard.ts`) returns either
 * `{ ok: true; opened: string }` or `{ ok: false; reason: OpenPathFailureReason }`.
 * The reason is a closed enum — surfaces should not interpolate the raw value
 * into UI; use {@link openPathFailureCopy} for human-facing strings.
 */

import type { UiLocale } from '@maka/core/ui-locale';
import { getShellCopy } from './locales/shell-copy.js';

export type OpenPathKey = 'workspace' | 'skills' | 'memory' | 'project';

export type OpenPathFailureReason = 'unknown-key' | 'not-allowed' | 'missing' | 'not-a-directory' | 'open-failed';

/** Closed-form mapping from enum to renderer-localized copy. */
export function openPathFailureCopy(reason: OpenPathFailureReason | string, locale: UiLocale): string {
  const copy = getShellCopy(locale).projectActions.openPathFailures;
  return reason in copy ? copy[reason as OpenPathFailureReason] : copy.unknown;
}

/**
 * Convenience that maps an `OpenPathKey` to the corresponding action label,
 * used by toast titles so we can show "在 Finder 中打开工作区失败" instead of
 * a generic "打开失败".
 */
export function openPathActionLabel(key: OpenPathKey, locale: UiLocale): string {
  return getShellCopy(locale).projectActions.openPathLabels[key];
}
