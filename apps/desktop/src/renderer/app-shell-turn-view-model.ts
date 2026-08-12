import { useRef } from 'react';
import type { UiLocale } from '@maka/core/ui-locale';
import {
  deriveTurnLineageMap,
  formatTurnDuration,
  isSandboxDeniedTool,
  type TurnFooterActionMeta,
  type TurnLineageBadge,
  type TurnLineageTarget,
  type TurnPresentation,
  type TurnPresentationDeriver,
  type TurnViewModel,
} from '@maka/ui';
import { deriveFailedTurnRecovery, describeTurnErrorClass } from './session-status-presentation.js';
import { deriveTurnFooterActions } from './turn-footer-actions.js';
import { deriveTurnLineageBadges } from './derive-turn-lineage-badges.js';
import { latestInterruptedResumeTurnId } from './interrupted-resume.js';

/** Everything outside the turn list that the per-turn presentation depends on. */
export interface AppShellTurnPresentationContext {
  activeId: string | undefined;
  pendingTurnActions: ReadonlySet<string>;
  uiLocale: UiLocale;
  pendingKeyOf(sessionId: string, turnId: string, actionId: TurnFooterActionMeta['id']): string;
}

export interface AppShellTurnPresentationDerivation {
  derive(turns: readonly TurnViewModel[], context: AppShellTurnPresentationContext): TurnPresentation;
}

/** What one turn contributes to the presentation; cached against that turn. */
interface TurnPresentationEntry {
  footerActions: ReadonlyArray<TurnFooterActionMeta>;
  lineageBadges?: TurnLineageBadge[];
  failedReasonLabel?: string;
  failedRecoveryLabel?: string;
}

const PENDING_ACTION_IDS = ['regenerate', 'branch', 'copy'] as const;

function isSandboxOnlyToolFailure(turn: TurnViewModel): boolean {
  const erroredTools = turn.tools.filter((tool) => tool.status === 'errored');
  if (erroredTools.length === 0 || !erroredTools.every(isSandboxDeniedTool)) return false;

  const errorClass = turn.errorClass?.toLowerCase();
  return (
    errorClass === undefined
    || errorClass === 'unknown'
    || errorClass === 'tool_failed'
    || errorClass === 'sandbox_denial'
    || errorClass === 'sandbox_denied'
  );
}

/**
 * Per-turn presentation derived from the turns the transcript projection
 * already produced (#2030).
 *
 * The shell used to run `materializeTurns` a second time over the raw message
 * log to derive these props, which made the transcript a two-authority
 * derivation and left the props with no stable identity of their own — they
 * had to be interned by value afterwards so a memoized `TurnView` could skip.
 * Reading the projected turns instead removes both problems at once: the turn
 * object IS the cache key, so a turn the projection did not move costs one
 * `WeakMap` hit and its props come back as the same objects.
 */
export function createAppShellTurnPresentationDerivation(): AppShellTurnPresentationDerivation {
  let cache = new WeakMap<TurnViewModel, { key: string; entry: TurnPresentationEntry }>();
  let lastTurns: readonly TurnViewModel[] | undefined;
  let lastActiveId: string | undefined;
  let lastPendingTurnActions: ReadonlySet<string> | undefined;
  let lastUiLocale: UiLocale | undefined;
  let lastResult: TurnPresentation | undefined;

  function derive(
    turns: readonly TurnViewModel[],
    context: AppShellTurnPresentationContext,
  ): TurnPresentation {
    if (
      lastResult
      && turns === lastTurns
      && context.activeId === lastActiveId
      && context.pendingTurnActions === lastPendingTurnActions
      && context.uiLocale === lastUiLocale
    ) {
      // Idempotent for identical inputs, so calling this during render stays
      // safe under React's double invocation.
      return lastResult;
    }
    // The locale is baked into every cached label, so it invalidates wholesale
    // rather than participating in the per-turn key.
    if (context.uiLocale !== lastUiLocale) cache = new WeakMap();

    const lineage = deriveTurnLineageMap(turns);
    const turnIds = new Set(turns.map((turn) => turn.turnId));
    const existsTurn = (id: string) => turnIds.has(id);
    const footerActionsByTurn: Record<string, ReadonlyArray<TurnFooterActionMeta>> = {};
    const failedReasonLabels: Record<string, string> = {};
    const failedRecoveryLabels: Record<string, string> = {};
    const lineageBadgesByTurn: Record<string, TurnLineageBadge[]> = {};

    for (const turn of turns) {
      const lineageEntry = lineage.get(turn.turnId);
      const pendingForTurn = new Set<TurnFooterActionMeta['id']>();
      for (const id of PENDING_ACTION_IDS) {
        if (context.activeId && context.pendingTurnActions.has(context.pendingKeyOf(context.activeId, turn.turnId, id))) {
          pendingForTurn.add(id);
        }
      }
      // Everything that can move while the turn object does not: the links
      // pointing AT this turn (a later regeneration), whether the turn it
      // points back at is still present, and its own pending actions.
      const key = [
        lineageEntry?.retriedToTurnId ?? '',
        lineageEntry?.regeneratedToTurnId ?? '',
        turn.retriedFromTurnId && existsTurn(turn.retriedFromTurnId) ? '1' : '0',
        turn.regeneratedFromTurnId && existsTurn(turn.regeneratedFromTurnId) ? '1' : '0',
        [...pendingForTurn].sort().join(','),
      ].join('\u0000');
      const cached = cache.get(turn);
      let entry: TurnPresentationEntry;
      if (cached && cached.key === key) {
        entry = cached.entry;
      } else {
        entry = deriveTurnPresentationEntry({
          turn,
          lineageEntry,
          pendingForTurn,
          existsTurn,
          uiLocale: context.uiLocale,
        });
        cache.set(turn, { key, entry });
      }

      footerActionsByTurn[turn.turnId] = entry.footerActions;
      if (entry.lineageBadges) lineageBadgesByTurn[turn.turnId] = entry.lineageBadges;
      if (entry.failedReasonLabel !== undefined) failedReasonLabels[turn.turnId] = entry.failedReasonLabel;
      if (entry.failedRecoveryLabel !== undefined) failedRecoveryLabels[turn.turnId] = entry.failedRecoveryLabel;
    }

    const resumeCandidateTurnId = latestInterruptedResumeTurnId(turns);
    lastTurns = turns;
    lastActiveId = context.activeId;
    lastPendingTurnActions = context.pendingTurnActions;
    lastUiLocale = context.uiLocale;
    lastResult = {
      footerActionsByTurn,
      failedReasonLabels,
      failedRecoveryLabels,
      lineageBadgesByTurn,
      ...(resumeCandidateTurnId ? { resumeCandidateTurnId } : {}),
    };
    return lastResult;
  }

  return { derive };
}

function deriveTurnPresentationEntry(input: {
  turn: TurnViewModel;
  lineageEntry: TurnLineageTarget | undefined;
  pendingForTurn: ReadonlySet<TurnFooterActionMeta['id']>;
  existsTurn(id: string): boolean;
  uiLocale: UiLocale;
}): TurnPresentationEntry {
  const { turn, lineageEntry, pendingForTurn, uiLocale } = input;
  const metaParts: string[] = [];
  if (turn.modelId) metaParts.push(turn.modelId);
  // Below a second there is nothing to report: a turn's duration counts whole
  // seconds, so a 300ms turn would read「0s」— a number that says less than no
  // number at all.
  if (turn.durationMs && turn.durationMs >= 1_000) metaParts.push(formatTurnDuration(turn.durationMs));
  if (turn.tokens?.costUsd && turn.tokens.costUsd > 0) metaParts.push(`$${turn.tokens.costUsd.toFixed(4)}`);
  const metaSummary = metaParts.length > 0 ? metaParts.join(' · ') : undefined;
  const footerActions = deriveTurnFooterActions({
    status: turn.status,
    locale: uiLocale,
    hasContent: Boolean(turn.assistant?.text && turn.assistant.text.trim().length > 0),
    // Match the badge lineage rule (regenerate ?? legacy retry) so a turn
    // that already has a parallel answer hints at it in the tooltip too.
    ...((lineageEntry?.regeneratedToTurnId ?? lineageEntry?.retriedToTurnId)
      ? { alreadyRegenerated: true }
      : {}),
    ...(pendingForTurn.size > 0 ? { pendingActions: pendingForTurn } : {}),
    ...(metaSummary ? { metaSummary } : {}),
  });

  const entry: TurnPresentationEntry = { footerActions };

  if (turn.status === 'failed' && !isSandboxOnlyToolFailure(turn)) {
    entry.failedReasonLabel = describeTurnErrorClass(turn.errorClass, uiLocale);
    entry.failedRecoveryLabel = deriveFailedTurnRecovery({
      errorClass: turn.errorClass,
      partialOutputRetained: turn.partialOutputRetained,
      toolActivityCount: turn.tools.length,
      erroredToolCount: turn.tools.filter((tool) => tool.status === 'errored').length,
    }, uiLocale).label;
  }

  const lineageBadges = deriveTurnLineageBadges({
    turnId: turn.turnId,
    retriedFromTurnId: turn.retriedFromTurnId,
    regeneratedFromTurnId: turn.regeneratedFromTurnId,
    retriedToTurnId: lineageEntry?.retriedToTurnId,
    regeneratedToTurnId: lineageEntry?.regeneratedToTurnId,
    existsTurn: input.existsTurn,
    locale: uiLocale,
  });
  if (lineageBadges.length > 0) entry.lineageBadges = lineageBadges;

  return entry;
}

/**
 * One-shot derivation, for callers with no render loop to keep state across —
 * stories and tests. Passing this as ChatView's `deriveTurnPresentation` type
 * checks and renders correctly while throwing the cache away every render,
 * which is the entire optimization; use `useAppShellTurnPresentation` there.
 */
export function deriveAppShellTurnPresentation(
  turns: readonly TurnViewModel[],
  context: AppShellTurnPresentationContext,
): TurnPresentation {
  return createAppShellTurnPresentationDerivation().derive(turns, context);
}

/**
 * The shell's `deriveTurnPresentation` prop. What matters is that the
 * derivation — and therefore its cache — survives across renders, which is why
 * it lives in a ref rather than being rebuilt in the render body. The returned
 * function's own identity is not load-bearing: nothing memoizes on it, and a
 * fresh closure per render is what keeps a later `memo` on ChatView correct
 * when the context changes.
 */
export function useAppShellTurnPresentation(
  context: AppShellTurnPresentationContext,
): TurnPresentationDeriver {
  const derivation = useRef<AppShellTurnPresentationDerivation>(undefined);
  derivation.current ??= createAppShellTurnPresentationDerivation();
  return (turns) => derivation.current!.derive(turns, context);
}
