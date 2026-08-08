import { canonicalPricingConfigsEqual } from '@maka/core/usage-stats/pricing';
import type { PricingConfig } from '@maka/core/usage-stats/types';
import type { EffectivePricingEntry, PricingMutation } from '@maka/runtime-host/protocol';

/**
 * One authoritative, connection-scoped Pricing Settings snapshot assembled by
 * the Desktop Runtime Host adapter. Renderer consumers never receive paging
 * cursors or transport details.
 */
export interface DesktopPricingSnapshot {
  readonly hostEpoch: string;
  readonly connectionId: string;
  readonly revision: number;
  readonly entries: readonly EffectivePricingEntry[];
}

export interface DesktopPricingMutationInput {
  readonly base: DesktopPricingSnapshot;
  readonly mutation: PricingMutation;
}

export type PricingReconciliationTarget =
  | { readonly kind: 'upsert'; readonly pricing: Readonly<PricingConfig> }
  | {
      readonly kind: 'delete';
      readonly modelKey: string;
      readonly expected: 'builtin' | 'unpriced' | 'no_override';
    };

/**
 * Shared reconciliation semantics for the Host adapter and renderer recovery
 * path. Keeping provenance here prevents the two callers from drifting on
 * what counts as an already-applied mutation.
 */
export function pricingTargetMatchesSnapshot(
  target: PricingReconciliationTarget,
  snapshot: DesktopPricingSnapshot,
): boolean {
  const modelKey = target.kind === 'upsert' ? target.pricing.modelKey : target.modelKey;
  const current = snapshot.entries.find((entry) => entry.pricing.modelKey === modelKey);
  if (target.kind === 'upsert') {
    return current?.source === 'custom'
      && canonicalPricingConfigsEqual(current.pricing, target.pricing);
  }
  switch (target.expected) {
    case 'builtin':
      return current?.source === 'builtin';
    case 'unpriced':
      return current === undefined;
    case 'no_override':
      return current === undefined || current.source === 'builtin';
  }
}

export type DesktopPricingMutationOutcome =
  | {
      readonly kind: 'saved';
      readonly disposition: 'committed' | 'unchanged';
      readonly snapshot: DesktopPricingSnapshot;
    }
  | {
      readonly kind: 'saved_refresh_failed';
      readonly disposition: 'committed' | 'unchanged';
    }
  | {
      readonly kind: 'synchronized' | 'review_required';
      readonly reason: 'revision_conflict' | 'outcome_unknown';
      readonly snapshot: DesktopPricingSnapshot;
    }
  | {
      readonly kind: 'reconciliation_unavailable';
      readonly reason: 'revision_conflict' | 'outcome_unknown';
    };

/**
 * The complete renderer boundary for Pricing Settings. The production
 * DesktopRuntimeHostClient and Storybook/test adapters both satisfy it.
 */
export interface DesktopPricingSettingsPort {
  loadPricingSnapshot(): Promise<DesktopPricingSnapshot>;
  applyPricingMutation(
    input: DesktopPricingMutationInput,
  ): Promise<DesktopPricingMutationOutcome>;
}
