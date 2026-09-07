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

import type { ModelMessage } from './model-protocol.js';

const STATE_KEY = 'makaResponses';
const STATE_VERSION = 1;
const MAX_ITEM_ID_LENGTH = 512;
const MAX_PROFILE_LENGTH = 128;
const MAX_SUMMARY_PARTS = 128;
const MAX_SUMMARY_TEXT_LENGTH = 10_000_000;

export interface PlaintextResponsesReasoningState {
  readonly version: 1;
  readonly profile: string;
  readonly itemId: string;
  readonly summaryPartLengths: readonly number[];
}

export type PlaintextResponsesReasoningStateDecodeResult =
  | { readonly kind: 'missing' }
  | { readonly kind: 'unsupported-version'; readonly version: number }
  | { readonly kind: 'malformed'; readonly profile?: string }
  | { readonly kind: 'valid'; readonly state: PlaintextResponsesReasoningState };

export function plaintextResponsesReasoningProviderOptions(
  itemId: string,
  profile: string,
  summaryParts: readonly string[],
): NonNullable<ModelMessage['providerOptions']> | undefined {
  if (!isSafeItemId(itemId) || !isSafeProfile(profile) || !isSafeSummaryParts(summaryParts)) {
    return undefined;
  }
  return {
    [STATE_KEY]: {
      version: STATE_VERSION,
      profile,
      itemId,
      summaryPartLengths: summaryParts.map((part) => part.length),
    },
  };
}

export function decodePlaintextResponsesReasoningState(
  providerOptions: Readonly<Record<string, unknown>> | undefined,
): PlaintextResponsesReasoningStateDecodeResult {
  const raw = providerOptions?.[STATE_KEY];
  if (raw === undefined) return { kind: 'missing' };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { kind: 'malformed' };
  const record = raw as Record<string, unknown>;
  const profile = isSafeProfile(record.profile) ? record.profile : undefined;
  const itemId = isSafeItemId(record.itemId) ? record.itemId : undefined;
  if (isSafeStateVersion(record.version) && record.version !== STATE_VERSION) {
    return { kind: 'unsupported-version', version: record.version };
  }
  const baseInvalid = record.version !== STATE_VERSION || !profile || !itemId;
  if (baseInvalid) {
    return { kind: 'malformed', ...(profile ? { profile } : {}) };
  }
  if (
    !isSafeSummaryPartLengths(record.summaryPartLengths) ||
    Object.keys(record).some(
      (key) => !['version', 'profile', 'itemId', 'summaryPartLengths'].includes(key),
    )
  ) {
    return { kind: 'malformed', ...(profile ? { profile } : {}) };
  }
  return {
    kind: 'valid',
    state: {
      version: STATE_VERSION,
      profile,
      itemId,
      summaryPartLengths: record.summaryPartLengths,
    },
  };
}

export function responsesReasoningItemId(
  providerOptions: Readonly<Record<string, unknown>> | undefined,
): string | undefined {
  const plaintext = decodePlaintextResponsesReasoningState(providerOptions);
  if (plaintext.kind === 'valid') return plaintext.state.itemId;
  const openai = providerOptions?.openai;
  if (!openai || typeof openai !== 'object' || Array.isArray(openai)) return undefined;
  const itemId = (openai as { itemId?: unknown }).itemId;
  return isSafeItemId(itemId) ? itemId : undefined;
}

export function replayPlaintextResponsesProviderOptions(input: {
  providerOptionsKey: string;
  state: PlaintextResponsesReasoningState;
  text: string;
}): NonNullable<ModelMessage['providerOptions']> {
  return {
    [input.providerOptionsKey]: {
      itemId: input.state.itemId,
      reasoningSummary: reconstructSummaryParts(input.text, input.state),
      // Presence is meaningful to @ai-sdk/open-responses: null prevents its
      // fallback from copying the canonical text into content when the
      // provider replays reasoning through summary instead.
      reasoningContent: null,
    },
  };
}

export function safePlaintextResponsesReasoningItemId(value: unknown): string | undefined {
  return isSafeItemId(value) ? value : undefined;
}

function reconstructSummaryParts(
  text: string,
  state: PlaintextResponsesReasoningState,
): Array<{ type: 'summary_text'; text: string }> {
  let offset = 0;
  const parts = state.summaryPartLengths.map((length) => {
    const part = { type: 'summary_text' as const, text: text.slice(offset, offset + length) };
    offset += length;
    return part;
  });
  if (offset !== text.length) {
    throw new Error('Durable plaintext Responses reasoning summary boundaries do not match text');
  }
  return parts;
}

function isSafeItemId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_ITEM_ID_LENGTH &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

function isSafeStateVersion(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function isSafeSummaryParts(value: readonly string[] | undefined): value is readonly string[] {
  if (!value || value.length > MAX_SUMMARY_PARTS) return false;
  let total = 0;
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) return false;
    const part = value[index];
    if (typeof part !== 'string') return false;
    total += part.length;
    if (total > MAX_SUMMARY_TEXT_LENGTH) return false;
  }
  return true;
}

function isSafeSummaryPartLengths(value: unknown): value is readonly number[] {
  if (!Array.isArray(value) || value.length > MAX_SUMMARY_PARTS) return false;
  let total = 0;
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) return false;
    const length = value[index];
    if (!Number.isSafeInteger(length) || length < 0) return false;
    total += length;
    if (total > MAX_SUMMARY_TEXT_LENGTH) return false;
  }
  return true;
}

function isSafeProfile(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_PROFILE_LENGTH &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}
