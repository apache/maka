/**
 * Pure derivation of a turn's lineage badges.
 *
 * Extracted from `app-shell-turn-view-model` so the badge matrix is
 * unit-testable without dragging in the renderer's relative-import
 * graph (which node ESM can't resolve extension-less).
 *
 * #546: retry was merged into regenerate. The badge vocabulary is now
 * uniform — "重新生成自" (forward) and "已重新生成" (reverse) — regardless
 * of which path wrote the lineage. Old sessions may still carry
 * `retriedFromTurnId` / `retriedToTurnId` (written by the since-removed
 * retryTurn path); those are read back as regenerate lineages via the
 * `?? ` fallback, never shown as the legacy "重试自" / "已重试".
 */

import type { TurnLineageBadge } from '@maka/ui';
import type { UiLocale } from '@maka/core/ui-locale';
import { getDesktopConversationCopy } from './locales/conversation-copy.js';

export interface TurnLineageBadgeInput {
  turnId: string;
  /** Legacy retry lineage (old data). Falls back behind regenerated. */
  retriedFromTurnId?: string;
  regeneratedFromTurnId?: string;
  /** Legacy reverse retry target (old data). Falls back behind regenerated. */
  retriedToTurnId?: string;
  regeneratedToTurnId?: string;
  /** True when the target turn id still exists in the materialized view. */
  existsTurn(turnId: string): boolean;
  locale?: UiLocale;
}

export function deriveTurnLineageBadges(input: TurnLineageBadgeInput): TurnLineageBadge[] {
  const copy = getDesktopConversationCopy(input.locale ?? 'zh').lineage;
  const badges: TurnLineageBadge[] = [];

  const forwardFrom = input.regeneratedFromTurnId ?? input.retriedFromTurnId;
  if (forwardFrom && input.existsTurn(forwardFrom)) {
    badges.push({
      id: `forward-regen-${input.turnId}`,
      label: copy.regeneratedFrom,
      tooltip: copy.regeneratedFromTooltip,
      targetTurnId: forwardFrom,
      direction: 'forward',
    });
  }

  const reverseTo = input.regeneratedToTurnId ?? input.retriedToTurnId;
  if (reverseTo && input.existsTurn(reverseTo)) {
    badges.push({
      id: `reverse-regen-${input.turnId}`,
      label: copy.regeneratedTo,
      tooltip: copy.regeneratedToTooltip,
      targetTurnId: reverseTo,
      direction: 'reverse',
    });
  }

  return badges;
}
