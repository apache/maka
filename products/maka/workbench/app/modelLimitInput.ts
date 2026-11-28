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

export type ModelLimitKey =
  | 'contextWindow'
  | 'inputLimit'
  | 'maxOutputTokens'
  | 'compactionThreshold';

export type ModelLimitInputState =
  | { readonly kind: 'empty' }
  | { readonly kind: 'valid'; readonly value: number }
  | { readonly kind: 'invalid' };

export type ModelLimitStates = Record<ModelLimitKey, ModelLimitInputState>;

export type ModelLimitDefaults =
  | Partial<Record<ModelLimitKey, number | null | undefined>>
  | null
  | undefined;

export type ModelLimitConflicts = {
  inputLimit?: 'exceeds_context_window';
  compactionThreshold?: 'exceeds_capacity';
};

// Standard thousands comma grouping (128,000), underscore grouping (128_000), or plain digits,
// with optional decimal fraction and k/K (* 1,000) or m/M (* 1,000,000) suffix.
const TOKEN_COUNT_PATTERN = /^((?:\d{1,3}(?:,\d{3})+|\d+(?:_\d+)+|\d+))(?:\.(\d+))?([km]?)$/i;

/** Decimal token counts (not binary sizes); the persisted value stays a safe positive integer. */
export function parseTokenCountInput(input: string): number | null {
  const match = TOKEN_COUNT_PATTERN.exec(input.trim());
  if (!match) return null;
  const suffix = match[3]?.toLowerCase() ?? '';
  const places = suffix === 'm' ? 6 : suffix === 'k' ? 3 : 0;
  const whole = match[1].replace(/[,_]/g, '');
  const fraction = match[2] ?? '';
  // Shift decimal digits before converting: 1.001 * 1000 is not exactly 1001
  // in floating point, and rounding would silently accept fractional tokens.
  if (/[1-9]/.test(fraction.slice(places))) return null;
  const value = Number(whole + fraction.padEnd(places, '0').slice(0, places));
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

/** True when a valid input uses shorthand or grouping rather than plain digits. */
export function isShorthandTokenInput(input: string): boolean {
  const trimmed = input.trim();
  return trimmed !== '' && !/^\d+$/.test(trimmed) && parseTokenCountInput(trimmed) !== null;
}

export function parseModelLimitStates(limits: Record<ModelLimitKey, string>): ModelLimitStates {
  const parse = (raw: string): ModelLimitInputState => {
    const trimmed = raw.trim();
    if (!trimmed) return { kind: 'empty' };
    const value = parseTokenCountInput(trimmed);
    return value === null ? { kind: 'invalid' } : { kind: 'valid', value };
  };
  return {
    contextWindow: parse(limits.contextWindow),
    inputLimit: parse(limits.inputLimit),
    maxOutputTokens: parse(limits.maxOutputTokens),
    compactionThreshold: parse(limits.compactionThreshold),
  };
}

const positive = (value: number | null | undefined): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;

/**
 * Resolves the effective input capacity `min(contextWindow, inputLimit)` from typed
 * overrides and inherited model defaults. Invalid non-empty inputs do not fall back
 * to stale defaults.
 */
export function effectiveInputCapacity(
  states: Pick<ModelLimitStates, 'contextWindow' | 'inputLimit'>,
  defaults: ModelLimitDefaults,
): number | null {
  const defaultContext = positive(defaults?.contextWindow);
  const defaultInput = positive(defaults?.inputLimit);
  const contextWindow =
    states.contextWindow.kind === 'valid'
      ? states.contextWindow.value
      : states.contextWindow.kind === 'empty'
        ? defaultContext
        : null;
  // Treat an inherited default inputLimit as a separate ceiling when contextWindow is not
  // overridden, or when the model explicitly defines a tighter input ceiling than its
  // default context window.
  const inputLimit =
    states.inputLimit.kind === 'valid'
      ? states.inputLimit.value
      : states.inputLimit.kind === 'empty'
        ? states.contextWindow.kind !== 'valid'
          ? defaultInput
          : defaultInput !== null && (defaultContext === null || defaultInput < defaultContext)
            ? defaultInput
            : null
        : null;
  if (contextWindow !== null && inputLimit !== null) return Math.min(contextWindow, inputLimit);
  return contextWindow ?? inputLimit;
}

export function findModelLimitConflicts(
  states: ModelLimitStates,
  defaults: ModelLimitDefaults,
): ModelLimitConflicts {
  const conflicts: ModelLimitConflicts = {};
  const effectiveContextWindow =
    states.contextWindow.kind === 'valid'
      ? states.contextWindow.value
      : states.contextWindow.kind === 'empty'
        ? positive(defaults?.contextWindow)
        : null;
  if (
    states.inputLimit.kind === 'valid' &&
    effectiveContextWindow !== null &&
    states.inputLimit.value > effectiveContextWindow
  ) {
    conflicts.inputLimit = 'exceeds_context_window';
  }
  const capacity = effectiveInputCapacity(states, defaults);
  if (
    states.compactionThreshold.kind === 'valid' &&
    capacity !== null &&
    states.compactionThreshold.value > capacity
  ) {
    conflicts.compactionThreshold = 'exceeds_capacity';
  }
  return conflicts;
}

export function suggestedCompactionThreshold(
  states: Pick<ModelLimitStates, 'contextWindow' | 'inputLimit'>,
  defaults: ModelLimitDefaults,
): number | null {
  const capacity = effectiveInputCapacity(states, defaults);
  if (capacity === null) return null;
  return Math.max(1, Math.floor(capacity * 0.9));
}
