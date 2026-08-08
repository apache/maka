import {
  normalizePricingConfig,
  normalizePricingModelKey,
} from '@maka/core/usage-stats/pricing';
import type { PricingConfig } from '@maka/core/usage-stats/types';
import type { EffectivePricingEntry } from '@maka/runtime-host/protocol';
export {
  pricingTargetMatchesSnapshot,
} from '../../shared/runtime-host-pricing.js';
import type { DesktopPricingSnapshot } from '../../shared/runtime-host-pricing.js';

export type PricingDraftField =
  | 'modelKey'
  | 'inputUsdPer1M'
  | 'outputUsdPer1M'
  | 'cacheReadUsdPer1M'
  | 'cacheWriteUsdPer1M';

export type PricingDraftError =
  | 'required'
  | 'invalid_rate'
  | 'model_key_empty'
  | 'model_key_too_long'
  | 'duplicate_model_key';

export interface PricingDraft {
  readonly mode: 'add' | 'edit';
  readonly modelKey: string;
  readonly inputUsdPer1M: string;
  readonly outputUsdPer1M: string;
  readonly cacheReadUsdPer1M: string;
  readonly cacheWriteUsdPer1M: string;
}

export type PricingDraftValidation =
  | {
      readonly ok: true;
      readonly pricing: PricingConfig;
      readonly errors: Readonly<Partial<Record<PricingDraftField, PricingDraftError>>>;
    }
  | {
      readonly ok: false;
      readonly errors: Readonly<Partial<Record<PricingDraftField, PricingDraftError>>>;
    };

export type PricingMutationTarget =
  | { readonly kind: 'upsert'; readonly pricing: Readonly<PricingConfig> }
  | {
      readonly kind: 'delete';
      readonly modelKey: string;
      readonly expected: 'builtin' | 'unpriced';
    };

export type PricingReviewReason =
  | 'revision_conflict'
  | 'outcome_unknown'
  | 'authority_changed';

export type PricingRecoveryCause =
  | 'known_saved'
  | 'revision_conflict'
  | 'outcome_unknown'
  | 'stale';

export type PricingRecoveryDecision =
  | {
      readonly kind: 'complete';
      readonly notice: 'saved' | 'synchronized_conflict' | 'synchronized_unknown';
    }
  | {
      readonly kind: 'review';
      readonly reason: PricingReviewReason;
      readonly notice: 'review_conflict' | 'review_unknown' | 'authority_changed';
    };

export function createPricingDraft(entry?: EffectivePricingEntry): PricingDraft {
  if (!entry) {
    return {
      mode: 'add',
      modelKey: '',
      inputUsdPer1M: '',
      outputUsdPer1M: '',
      cacheReadUsdPer1M: '',
      cacheWriteUsdPer1M: '',
    };
  }
  return {
    mode: 'edit',
    modelKey: entry.pricing.modelKey,
    inputUsdPer1M: String(entry.pricing.inputUsdPer1M),
    outputUsdPer1M: String(entry.pricing.outputUsdPer1M),
    cacheReadUsdPer1M: rateDraftValue(entry.pricing.cacheReadUsdPer1M),
    cacheWriteUsdPer1M: rateDraftValue(entry.pricing.cacheWriteUsdPer1M),
  };
}

export function preparePricingDraftForAuthorityReview(
  draft: PricingDraft,
  entries: readonly EffectivePricingEntry[],
): PricingDraft {
  if (draft.mode !== 'add') return draft;
  const modelKey = normalizePricingModelKey(draft.modelKey);
  if (
    !modelKey.ok
    || !entries.some((entry) => entry.pricing.modelKey === modelKey.value)
  ) return draft;
  return { ...draft, mode: 'edit' };
}

export function validatePricingDraft(
  draft: PricingDraft,
  entries: readonly EffectivePricingEntry[],
): PricingDraftValidation {
  const errors: Partial<Record<PricingDraftField, PricingDraftError>> = {};
  const normalizedKey = normalizePricingModelKey(draft.modelKey);
  if (!normalizedKey.ok) {
    errors.modelKey = draft.modelKey.trim() === '' ? 'model_key_empty' : 'model_key_too_long';
  } else if (
    draft.mode === 'add'
    && entries.some((entry) => entry.pricing.modelKey === normalizedKey.value)
  ) {
    errors.modelKey = 'duplicate_model_key';
  }

  const input = parseRate(draft.inputUsdPer1M, true);
  if (!input.ok) errors.inputUsdPer1M = input.error;
  const output = parseRate(draft.outputUsdPer1M, true);
  if (!output.ok) errors.outputUsdPer1M = output.error;
  const cacheRead = parseRate(draft.cacheReadUsdPer1M, false);
  if (!cacheRead.ok) errors.cacheReadUsdPer1M = cacheRead.error;
  const cacheWrite = parseRate(draft.cacheWriteUsdPer1M, false);
  if (!cacheWrite.ok) errors.cacheWriteUsdPer1M = cacheWrite.error;

  if (
    !normalizedKey.ok
    || !input.ok
    || !output.ok
    || !cacheRead.ok
    || !cacheWrite.ok
    || Object.keys(errors).length > 0
  ) {
    return { ok: false, errors };
  }

  const canonical = normalizePricingConfig({
    modelKey: normalizedKey.value,
    inputUsdPer1M: input.value,
    outputUsdPer1M: output.value,
    ...(cacheRead.value !== undefined ? { cacheReadUsdPer1M: cacheRead.value } : {}),
    ...(cacheWrite.value !== undefined ? { cacheWriteUsdPer1M: cacheWrite.value } : {}),
  });
  if (!canonical.ok) {
    return { ok: false, errors: { inputUsdPer1M: 'invalid_rate' } };
  }
  return { ok: true, pricing: canonical.value, errors };
}

/** Display is deliberately separate from editor seeding and persisted input. */
export function formatPricingRate(rate: number): string {
  return `$${String(rate)}`;
}

export function pricingSnapshotIdentityChanged(
  previous: DesktopPricingSnapshot,
  current: DesktopPricingSnapshot,
): boolean {
  return previous.hostEpoch !== current.hostEpoch
    || previous.connectionId !== current.connectionId
    || previous.revision !== current.revision;
}

export function decidePricingRecovery(
  cause: PricingRecoveryCause,
  targetMatches: boolean,
): PricingRecoveryDecision {
  if (targetMatches) {
    if (cause === 'known_saved') return { kind: 'complete', notice: 'saved' };
    if (cause === 'outcome_unknown') {
      return { kind: 'complete', notice: 'synchronized_unknown' };
    }
    return { kind: 'complete', notice: 'synchronized_conflict' };
  }
  if (cause === 'revision_conflict') {
    return { kind: 'review', reason: 'revision_conflict', notice: 'review_conflict' };
  }
  if (cause === 'outcome_unknown') {
    return { kind: 'review', reason: 'outcome_unknown', notice: 'review_unknown' };
  }
  return { kind: 'review', reason: 'authority_changed', notice: 'authority_changed' };
}

export function createPricingDeleteTarget(
  entry: Extract<EffectivePricingEntry, { source: 'custom' }>,
): Extract<PricingMutationTarget, { kind: 'delete' }> {
  return {
    kind: 'delete',
    modelKey: entry.pricing.modelKey,
    expected: entry.resetEffect === 'restore_builtin' ? 'builtin' : 'unpriced',
  };
}

export function findCurrentPricingDeleteTarget(
  modelKey: string,
  entries: readonly EffectivePricingEntry[],
): Extract<PricingMutationTarget, { kind: 'delete' }> | undefined {
  const entry = entries.find(
    (candidate): candidate is Extract<EffectivePricingEntry, { source: 'custom' }> =>
      candidate.pricing.modelKey === modelKey && candidate.source === 'custom',
  );
  return entry ? createPricingDeleteTarget(entry) : undefined;
}

function rateDraftValue(rate: number | undefined): string {
  return rate === undefined ? '' : String(rate);
}

function parseRate(
  raw: string,
  required: boolean,
):
  | { readonly ok: true; readonly value: number | undefined }
  | { readonly ok: false; readonly error: PricingDraftError } {
  const trimmed = raw.trim();
  if (trimmed === '') {
    return required
      ? { ok: false, error: 'required' }
      : { ok: true, value: undefined };
  }
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value < 0) {
    return { ok: false, error: 'invalid_rate' };
  }
  return { ok: true, value };
}
