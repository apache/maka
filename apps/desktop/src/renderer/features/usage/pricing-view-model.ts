/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

/**
 * Pure derivations for the Pricing Settings panel — no React, no IPC — so the
 * row projection and the editor validation are unit-testable without a
 * renderer. The Host already returns entries as the canonical built-in ∪
 * overrides union in key order; this only maps them to display rows (re-sorting
 * defensively) and mirrors the Host's `normalizePricingConfig` rules per-field.
 */

import {
  comparePricingModelKeys,
  normalizePricingModelKey,
  pricingModelKey,
} from '@maka/core/usage-stats/pricing';
import type { PricingConfig } from '@maka/core/usage-stats/types';
import type { EffectivePricingEntry } from '@maka/runtime-host/protocol';

export interface PricingRowView {
  readonly modelKey: string;
  /** Display-only split of `modelKey` on its first colon. */
  readonly provider: string;
  readonly model: string;
  readonly source: 'builtin' | 'custom';
  /** null for a built-in row; the delete consequence for a custom row. */
  readonly resetEffect: 'restore_builtin' | 'become_unpriced' | null;
  readonly inputUsdPer1M: number;
  readonly outputUsdPer1M: number;
  /** `undefined` means "Not set" — distinct from an explicit `0`. */
  readonly cacheReadUsdPer1M: number | undefined;
  readonly cacheWriteUsdPer1M: number | undefined;
}

export function derivePricingRows(
  entries: readonly EffectivePricingEntry[],
): PricingRowView[] {
  return [...entries]
    .sort((left, right) =>
      comparePricingModelKeys(left.pricing.modelKey, right.pricing.modelKey),
    )
    .map((entry) => {
      const key = entry.pricing.modelKey;
      const separator = key.indexOf(':');
      return {
        modelKey: key,
        provider: separator < 0 ? '' : key.slice(0, separator),
        model: separator < 0 ? key : key.slice(separator + 1),
        source: entry.source,
        resetEffect: entry.source === 'custom' ? entry.resetEffect : null,
        inputUsdPer1M: entry.pricing.inputUsdPer1M,
        outputUsdPer1M: entry.pricing.outputUsdPer1M,
        cacheReadUsdPer1M: entry.pricing.cacheReadUsdPer1M,
        cacheWriteUsdPer1M: entry.pricing.cacheWriteUsdPer1M,
      };
    });
}

export interface PricingDraft {
  readonly provider: string;
  readonly model: string;
  /** `null` = the field is empty (a cleared NumberInput). */
  readonly input: number | null;
  readonly output: number | null;
  readonly cacheRead: number | null;
  readonly cacheWrite: number | null;
}

export type PricingRateErrorCode = 'required' | 'invalid_rate';
export type PricingKeyErrorCode = 'required' | 'key_too_long' | 'duplicate';

export interface PricingDraftErrors {
  provider?: 'required';
  model?: PricingKeyErrorCode;
  input?: PricingRateErrorCode;
  output?: PricingRateErrorCode;
  cacheRead?: 'invalid_rate';
  cacheWrite?: 'invalid_rate';
}

export interface PricingDraftValidation {
  readonly errors: PricingDraftErrors;
  readonly hasErrors: boolean;
  /** The canonical config to send, present iff `hasErrors` is false. */
  readonly config: PricingConfig | null;
}

export function validatePricingDraft(
  draft: PricingDraft,
  options: {
    readonly mode: 'add' | 'edit';
    readonly existingKeys: readonly string[];
    /** Required in edit mode — the fixed identity key. */
    readonly lockedModelKey?: string;
  },
): PricingDraftValidation {
  const errors: PricingDraftErrors = {};

  let modelKey: string | null = null;
  if (options.mode === 'edit') {
    modelKey = options.lockedModelKey ?? null;
  } else {
    const provider = draft.provider.trim();
    const model = draft.model.trim();
    if (provider === '') errors.provider = 'required';
    if (model === '') errors.model = 'required';
    if (provider !== '' && model !== '') {
      const normalized = normalizePricingModelKey(pricingModelKey(provider, model));
      if (!normalized.ok) {
        errors.model = 'key_too_long';
      } else if (options.existingKeys.includes(normalized.value)) {
        errors.model = 'duplicate';
      } else {
        modelKey = normalized.value;
      }
    }
  }

  const input = validateRequiredRate(draft.input);
  if (input !== 'ok') errors.input = input;
  const output = validateRequiredRate(draft.output);
  if (output !== 'ok') errors.output = output;
  if (draft.cacheRead !== null && !isValidRate(draft.cacheRead)) {
    errors.cacheRead = 'invalid_rate';
  }
  if (draft.cacheWrite !== null && !isValidRate(draft.cacheWrite)) {
    errors.cacheWrite = 'invalid_rate';
  }

  const hasErrors = Object.keys(errors).length > 0;
  const config: PricingConfig | null =
    !hasErrors && modelKey !== null && draft.input !== null && draft.output !== null
      ? {
          modelKey,
          inputUsdPer1M: draft.input,
          outputUsdPer1M: draft.output,
          ...(draft.cacheRead !== null ? { cacheReadUsdPer1M: draft.cacheRead } : {}),
          ...(draft.cacheWrite !== null ? { cacheWriteUsdPer1M: draft.cacheWrite } : {}),
        }
      : null;

  return { errors, hasErrors, config };
}

function validateRequiredRate(value: number | null): 'ok' | PricingRateErrorCode {
  if (value === null) return 'required';
  return isValidRate(value) ? 'ok' : 'invalid_rate';
}

function isValidRate(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}
