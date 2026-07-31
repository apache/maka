import type { StoredMessage, UiLocale } from '@maka/core';
import {
  deriveTurnLineageMap,
  formatTurnDuration,
  isSandboxDeniedTool,
  materializeTurns,
  type TurnFooterActionMeta,
  type TurnLineageBadge,
  type TurnViewModel,
} from '@maka/ui';
import { deriveFailedTurnRecovery, describeTurnErrorClass } from './session-status-presentation.js';
import { deriveTurnFooterActions } from './turn-footer-actions.js';
import { deriveTurnLineageBadges } from './derive-turn-lineage-badges.js';
import { latestInterruptedResumeTurnId } from './interrupted-resume.js';

export interface AppShellTurnViewModel {
  turnFooterActionsByTurn: Record<string, ReadonlyArray<TurnFooterActionMeta>>;
  turnFailedReasonLabels: Record<string, string>;
  turnFailedRecoveryLabels: Record<string, string>;
  turnLineageBadgesByTurn: Record<string, TurnLineageBadge[]>;
  resumeCandidateTurnId?: string;
}

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

export function deriveAppShellTurnViewModel(input: {
  activeId: string | undefined;
  messages: StoredMessage[];
  pendingTurnActions: ReadonlySet<string>;
  uiLocale: UiLocale;
  pendingKeyOf(sessionId: string, turnId: string, actionId: TurnFooterActionMeta['id']): string;
}): AppShellTurnViewModel {
  const turnsForLineage = materializeTurns(input.messages);
  const resumeCandidateTurnId = latestInterruptedResumeTurnId(turnsForLineage);
  const lineage = deriveTurnLineageMap(turnsForLineage);
  const turnsById = new Map(turnsForLineage.map((turn) => [turn.turnId, turn]));
  const footer: Record<string, ReadonlyArray<TurnFooterActionMeta>> = {};
  const failedLabels: Record<string, string> = {};
  const failedRecoveryLabels: Record<string, string> = {};
  const badges: Record<string, TurnLineageBadge[]> = {};

  for (const turn of turnsForLineage) {
    const lineageEntry = lineage.get(turn.turnId);
    const pendingForTurn = new Set<TurnFooterActionMeta['id']>();
    for (const id of ['regenerate', 'branch', 'copy'] as const) {
      if (input.activeId && input.pendingTurnActions.has(input.pendingKeyOf(input.activeId, turn.turnId, id))) {
        pendingForTurn.add(id);
      }
    }
    const metaParts: string[] = [];
    if (turn.modelId) metaParts.push(turn.modelId);
    if (turn.durationMs && turn.durationMs > 0) metaParts.push(formatTurnDuration(turn.durationMs));
    if (turn.tokens?.costUsd && turn.tokens.costUsd > 0) metaParts.push(`$${turn.tokens.costUsd.toFixed(4)}`);
    const metaSummary = metaParts.length > 0 ? metaParts.join(' · ') : undefined;
    footer[turn.turnId] = deriveTurnFooterActions({
      status: turn.status,
      locale: input.uiLocale,
      hasContent: Boolean(turn.assistant?.text && turn.assistant.text.trim().length > 0),
      // Match the badge lineage rule (regenerate ?? legacy retry) so a turn
      // that already has a parallel answer hints at it in the tooltip too.
      ...((lineageEntry?.regeneratedToTurnId ?? lineageEntry?.retriedToTurnId)
        ? { alreadyRegenerated: true }
        : {}),
      ...(pendingForTurn.size > 0 ? { pendingActions: pendingForTurn } : {}),
      ...(metaSummary ? { metaSummary } : {}),
    });

    if (turn.status === 'failed' && !isSandboxOnlyToolFailure(turn)) {
      failedLabels[turn.turnId] = describeTurnErrorClass(turn.errorClass, input.uiLocale);
      failedRecoveryLabels[turn.turnId] = deriveFailedTurnRecovery({
        errorClass: turn.errorClass,
        partialOutputRetained: turn.partialOutputRetained,
        toolActivityCount: turn.tools.length,
        erroredToolCount: turn.tools.filter((tool) => tool.status === 'errored').length,
      }, input.uiLocale).label;
    }

    const turnBadges = deriveTurnLineageBadges({
      turnId: turn.turnId,
      retriedFromTurnId: turn.retriedFromTurnId,
      regeneratedFromTurnId: turn.regeneratedFromTurnId,
      retriedToTurnId: lineageEntry?.retriedToTurnId,
      regeneratedToTurnId: lineageEntry?.regeneratedToTurnId,
      existsTurn: (id) => turnsById.has(id),
      locale: input.uiLocale,
    });
    if (turnBadges.length > 0) badges[turn.turnId] = turnBadges;
  }

  return {
    turnFooterActionsByTurn: footer,
    turnFailedReasonLabels: failedLabels,
    turnFailedRecoveryLabels: failedRecoveryLabels,
    turnLineageBadgesByTurn: badges,
    ...(resumeCandidateTurnId ? { resumeCandidateTurnId } : {}),
  };
}
