// Pure status helper for the Settings → 模型 connection list. Kept out
// of `providers-panel.tsx` (no React, no DOM) so the decision logic can be
// exercised directly from the desktop test runner. Behavioural tests live
// in `provider-connection-status.test.ts`.

import type { LlmConnection } from '@maka/core/llm-connections';

import type { UiLocale } from '@maka/core/ui-locale';
import { getProviderSettingsCopy } from '../locales/settings-provider-copy.js';
import type { StatusSemantic } from '@maka/ui';

export interface ConnectionChipStatus {
  label: string;
  tone: StatusSemantic;
}

/**
 * Status copy + tone for one connection's Badge in the 模型连接 list. One
 * state machine returns both so the color can never disagree with the
 * visible copy (PR #988 review: split label/tone helpers drifted — a
 * disabled connection that last errored kept the failure copy but lost the
 * destructive tone).
 *
 * Branches, in priority order:
 * - needs_reauth: a lapsed OAuth subscription login arrives as
 *   enabled:false + needs_reauth (main.ts subscription sync keeps the
 *   connection but flags it). That is a "please log back in" signal, not a
 *   user-killed connection, so needs_reauth wins over the disabled check
 *   and must never read as "已禁用".
 * - !enabled + error: a failed Runtime Host connection effect can persist
 *   enabled:false + lastTestStatus:'error', so the failure signal
 *   must survive the disabled state — label carries both facts, tone stays
 *   destructive.
 * - !enabled (bare, or disabled+verified): neutral "暂不可用". A stale
 *   verified result must not paint a green light on an unusable connection.
 * - verified: PR-UI-AUDIT-1 (@kenji msg 7a16aa0b): `verified` is a
 *   credential-validation result only; it does NOT prove agent send /
 *   stream / interrupt paths are operational (provider-auth contract).
 *   Older copy "已验证可用" conflated validation with operational
 *   readiness, fixed to credential-only language. Matches the doc warning
 *   at SettingsModal `验证通过 ≠ 运行可用`.
 */
export function connectionChipStatus(connection: LlmConnection, locale: UiLocale = 'zh'): ConnectionChipStatus | null {
  const copy = getProviderSettingsCopy(locale).shared.connectionStatuses;
  // Waiting on the user, not on the system: an expired credential is a
  // to-do, and it used to render as the live accent dot — reporting progress
  // where nothing is progressing.
  if (connection.lastTestStatus === 'needs_reauth') return { label: copy.reauth, tone: 'attention' };
  if (!connection.enabled) {
    return connection.lastTestStatus === 'error'
      ? { label: copy.disabledFailed, tone: 'error' }
      : { label: copy.disabled, tone: 'neutral' };
  }
  switch (connection.lastTestStatus) {
    case 'verified':
      return null;
    case 'error':
      return { label: copy.failed, tone: 'error' };
    default:
      return null;
  }
}
