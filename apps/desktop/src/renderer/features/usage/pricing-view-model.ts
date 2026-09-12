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
 * Pricing draft conversion and field validation. The UI reads the Host's
 * effective entries directly; only editable drafts need a different shape.
 */

import { normalizePricingModelKey } from '@maka/core/usage-stats/pricing';
import type { PricingConfig } from '@maka/core/usage-stats/types';

export interface PricingDraft {
  readonly modelKey: string;
  /** `null` = the field is empty (a cleared NumberInput). */
  readonly input: number | null;
  readonly output: number | null;
  readonly cacheRead: number | null;
  readonly cacheWrite: number | null;
}

/** In-memory user input survives the Settings Host/loading gates remounting the view. */
export interface PricingEditorDraft {
  readonly mode: 'catalog' | 'manual' | 'edit';
  readonly draft: PricingDraft;
  readonly cacheOpen: boolean;
}

/**
 * The editor draft pre-filled from an existing row — shared by the Edit flow and
 * the Add flow's catalog pick. `cacheOpen` is true iff the row carries either
 * cache rate (an explicit `0` counts; only `undefined` is "Not set").
 */
export function draftFromPricing(pricing: PricingConfig): {
  readonly draft: PricingDraft;
  readonly cacheOpen: boolean;
} {
  return {
    draft: {
      modelKey: pricing.modelKey,
      input: pricing.inputUsdPer1M,
      output: pricing.outputUsdPer1M,
      cacheRead: pricing.cacheReadUsdPer1M ?? null,
      cacheWrite: pricing.cacheWriteUsdPer1M ?? null,
    },
    cacheOpen: pricing.cacheReadUsdPer1M !== undefined || pricing.cacheWriteUsdPer1M !== undefined,
  };
}

export type PricingRateErrorCode = 'required' | 'invalid_rate';
export type PricingKeyErrorCode = 'required' | 'key_too_long' | 'duplicate';

export interface PricingDraftErrors {
  modelKey?: PricingKeyErrorCode;
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
    const normalized = normalizePricingModelKey(draft.modelKey);
    if (!normalized.ok) {
      errors.modelKey = draft.modelKey.trim() === '' ? 'required' : 'key_too_long';
    } else if (options.existingKeys.includes(normalized.value)) {
      errors.modelKey = 'duplicate';
    } else {
      modelKey = normalized.value;
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
