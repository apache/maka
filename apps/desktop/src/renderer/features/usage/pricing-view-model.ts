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
  /** Raw input, including incomplete decimals; an empty string means not set. */
  readonly input: string;
  readonly output: string;
  readonly cacheRead: string;
  readonly cacheWrite: string;
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
      input: String(pricing.inputUsdPer1M),
      output: String(pricing.outputUsdPer1M),
      cacheRead: pricing.cacheReadUsdPer1M === undefined ? '' : String(pricing.cacheReadUsdPer1M),
      cacheWrite: pricing.cacheWriteUsdPer1M === undefined ? '' : String(pricing.cacheWriteUsdPer1M),
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

  const input = parseRate(draft.input);
  const output = parseRate(draft.output);
  const cacheRead = parseRate(draft.cacheRead);
  const cacheWrite = parseRate(draft.cacheWrite);
  if (input === null) errors.input = 'required';
  else if (!isValidRate(input)) errors.input = 'invalid_rate';
  if (output === null) errors.output = 'required';
  else if (!isValidRate(output)) errors.output = 'invalid_rate';
  if (cacheRead !== null && !isValidRate(cacheRead)) errors.cacheRead = 'invalid_rate';
  if (cacheWrite !== null && !isValidRate(cacheWrite)) errors.cacheWrite = 'invalid_rate';

  const hasErrors = Object.keys(errors).length > 0;
  const config: PricingConfig | null =
    !hasErrors && modelKey !== null && input !== null && output !== null
      ? {
          modelKey,
          inputUsdPer1M: input,
          outputUsdPer1M: output,
          ...(cacheRead !== null ? { cacheReadUsdPer1M: cacheRead } : {}),
          ...(cacheWrite !== null ? { cacheWriteUsdPer1M: cacheWrite } : {}),
        }
      : null;

  return { errors, hasErrors, config };
}

function parseRate(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  // Accept decimal/scientific notation (including String()'s tiny rates), but
  // never coerce malformed text, hexadecimal, or a negative price to zero.
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(trimmed)) return NaN;
  const value = Number(trimmed);
  // A nonzero rate below Number's range must not silently become free.
  if (value === 0 && /[1-9]/.test(trimmed.split(/e/i)[0]!)) return NaN;
  return value;
}

function isValidRate(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}
