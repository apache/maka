/**
 * Pure derivation of turn footer action enabled-set.
 *
 * Lives outside the React component layer so the action × TurnStatus
 * × lineage matrix can be unit-tested with node:test. Mirrors the
 * other renderer-level pure derivations such as `session-health-notice.ts`.
 *
 * Footer actions (icon + Chinese text — see the TurnFooterActions
 * component for the actual buttons):
 *
 *   - regenerate     🔁 重新生成 → for any non-running turn (failed / aborted / completed)
 *   - branch         🌿 分支     → for any non-running turn (incl. aborted)
 *   - copy           📋 复制     → always available when there's content
 *
 * Running turns get only `copy` (the long-running operation finishes
 * naturally; cancel lives in the Composer Stop button, not the footer).
 *
 * #546: retry was merged into regenerate. One "重新生成" action re-runs
 * the turn regardless of how the previous attempt ended. The separate
 * retry action / lineage field is gone.
 *
 * @kenji review gate #1: footer enabled set is computed
 * **exclusively** from `TurnStatus` + lineage map, NOT from text
 * content or any optimistic UI state. This file is the canonical
 * source of that decision.
 */

import type { TurnStatus, UiLocale } from '@maka/core';
import { getDesktopConversationCopy } from './locales/conversation-copy.js';

export type TurnFooterActionId = 'regenerate' | 'branch' | 'copy' | 'info';

export interface TurnFooterAction {
  id: TurnFooterActionId;
  /** Chinese button label. */
  label: string;
  /**
   * Whether the button is enabled for this turn. A disabled button is
   * still rendered (so the user can see what actions exist on the
   * turn) but the click handler is a no-op. UI may also hide
   * disabled actions in compact mode.
   */
  enabled: boolean;
  /**
   * Tooltip explaining why the action is enabled/disabled. Always
   * Chinese; never exposes the raw TurnStatus enum identifier.
   */
  tooltip?: string;
}

export interface TurnFooterContext {
  status: TurnStatus;
  /**
   * True when the turn has at least one materialized assistant message
   * with non-empty text. Disables `copy` for empty turns (running
   * turns before the first delta, or aborted with no partial output).
   */
  hasContent: boolean;
  /**
   * True when there's already a regenerate sibling for this turn.
   * Used to hint at "已重新生成" in the tooltip so the user
   * understands a parallel answer already exists.
   */
  alreadyRegenerated?: boolean;
  /**
   * Optional one-line summary of the turn's meta (model · duration ·
   * cost). When present, the footer renders an `info` action
   * whose tooltip carries this text — the single home for turn meta
   * now that the top summary row is gone (#546). Absent on turns with
   * no meta (fake backend, not-yet-streamed).
   */
  metaSummary?: string;
  /**
   * Per @kenji review: prevent double-click duplicate sibling turns.
   * The renderer marks an action `pending` from click time until
   * `sessions:changed` (or timeout) clears it; the footer renders that
   * action as disabled + busy with a "正在处理…" tooltip. Other turns
   * / other action types stay clickable.
   */
  pendingActions?: ReadonlySet<TurnFooterActionId>;
  locale?: UiLocale;
}

/**
 * Derive the ordered list of footer actions to render for a turn.
 * The order is fixed at the matrix level (regenerate → branch → copy)
 * so adjacent buttons line up across rows even when some are disabled.
 *
 * @kenji gate: returned `enabled` flags depend only on `TurnStatus`
 * and lineage state; we never sniff the turn text or fall back to
 * optimistic guesses.
 */
export function deriveTurnFooterActions(input: TurnFooterContext): TurnFooterAction[] {
  const { status, hasContent, alreadyRegenerated, pendingActions, metaSummary } = input;
  const copyText = getDesktopConversationCopy(input.locale ?? 'zh').footer;
  const actionLabel = copyText.labels;
  const isPending = (id: TurnFooterActionId) => pendingActions?.has(id) ?? false;
  const PENDING_TOOLTIP = copyText.pending;

  const regenerate: TurnFooterAction = isPending('regenerate')
    ? { id: 'regenerate', label: actionLabel.regenerate, enabled: false, tooltip: PENDING_TOOLTIP }
    : {
        id: 'regenerate',
        label: actionLabel.regenerate,
        enabled: status !== 'running',
        tooltip:
          status === 'running'
            ? copyText.regenerateRunning
            : alreadyRegenerated
            ? copyText.regenerateAgain
            : copyText.regenerate,
      };
  const branch: TurnFooterAction = isPending('branch')
    ? { id: 'branch', label: actionLabel.branch, enabled: false, tooltip: PENDING_TOOLTIP }
    : {
        id: 'branch',
        label: actionLabel.branch,
        enabled: status !== 'running',
        tooltip:
          status === 'running'
            ? copyText.branchRunning
            : status === 'aborted'
            ? copyText.branchAborted
            : copyText.branch,
      };
  const copy: TurnFooterAction = {
    id: 'copy',
    label: actionLabel.copy,
    enabled: hasContent,
    tooltip: hasContent ? copyText.copy : copyText.copyEmpty,
  };

  // info is informational, not an operation: no pending state, always
  // enabled, and its tooltip carries the turn meta summary. Rendered
  // only when there is meta to show (#546).
  const info: TurnFooterAction | undefined = metaSummary
    ? { id: 'info', label: actionLabel.info, enabled: true, tooltip: metaSummary }
    : undefined;

  return [regenerate, branch, copy, ...(info ? [info] : [])];
}

/**
 * Convenience filter: keep only actions that are enabled. Used by the
 * compact-mode renderer where disabled buttons are hidden.
 */
export function enabledTurnFooterActions(input: TurnFooterContext): TurnFooterAction[] {
  return deriveTurnFooterActions(input).filter((action) => action.enabled);
}
