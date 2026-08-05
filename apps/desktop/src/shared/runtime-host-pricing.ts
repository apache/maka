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
