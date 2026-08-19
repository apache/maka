import type { ModelMessage } from './model-protocol.js';

const STATE_KEY = 'makaResponses';
const STATE_VERSION = 1;
const MAX_ITEM_ID_LENGTH = 512;
const MAX_PROFILE_LENGTH = 128;
const MAX_SUMMARY_PARTS = 128;
const MAX_SUMMARY_TEXT_LENGTH = 10_000_000;

export type PlaintextResponsesReasoningCarrier = 'content' | 'summary';

export type PlaintextResponsesReasoningState = {
  readonly version: 1;
  readonly profile: string;
  readonly itemId: string;
} & (
  | { readonly carrier: 'content' }
  | {
      readonly carrier: 'summary';
      readonly summaryPartLengths: readonly number[];
    }
);

export type PlaintextResponsesReasoningStateDecodeResult =
  | { readonly kind: 'missing' }
  | { readonly kind: 'malformed'; readonly profile?: string }
  | { readonly kind: 'valid'; readonly state: PlaintextResponsesReasoningState };

export function plaintextResponsesReasoningProviderOptions(
  itemId: string,
  carrier: PlaintextResponsesReasoningCarrier,
  profile: string,
  summaryParts?: readonly string[],
): NonNullable<ModelMessage['providerOptions']> | undefined {
  if (!isSafeItemId(itemId) || !isSafeProfile(profile)) return undefined;
  if (carrier === 'summary') {
    if (!isSafeSummaryParts(summaryParts)) return undefined;
    return {
      [STATE_KEY]: {
        version: STATE_VERSION,
        profile,
        itemId,
        carrier,
        summaryPartLengths: summaryParts.map((part) => part.length),
      },
    };
  }
  return {
    [STATE_KEY]: { version: STATE_VERSION, profile, itemId, carrier },
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
  const baseInvalid =
    record.version !== STATE_VERSION ||
    !profile ||
    !itemId ||
    (record.carrier !== 'content' && record.carrier !== 'summary');
  if (baseInvalid) {
    return { kind: 'malformed', ...(profile ? { profile } : {}) };
  }
  if (record.carrier === 'content') {
    if (
      Object.keys(record).some((key) => !['version', 'profile', 'itemId', 'carrier'].includes(key))
    ) {
      return { kind: 'malformed', ...(profile ? { profile } : {}) };
    }
    return {
      kind: 'valid',
      state: {
        version: STATE_VERSION,
        profile,
        itemId,
        carrier: 'content',
      },
    };
  }
  if (
    !isSafeSummaryPartLengths(record.summaryPartLengths) ||
    Object.keys(record).some(
      (key) => !['version', 'profile', 'itemId', 'carrier', 'summaryPartLengths'].includes(key),
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
      carrier: 'summary',
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
  const reasoningSummary =
    input.state.carrier === 'summary' ? reconstructSummaryParts(input.text, input.state) : [];
  return {
    [input.providerOptionsKey]: {
      itemId: input.state.itemId,
      reasoningSummary,
      // Presence is meaningful to @ai-sdk/open-responses: null prevents its
      // fallback from copying the canonical text into content when the
      // provider replays reasoning through summary instead.
      reasoningContent:
        input.state.carrier === 'content' ? [{ type: 'reasoning_text', text: input.text }] : null,
    },
  };
}

export function safePlaintextResponsesReasoningItemId(value: unknown): string | undefined {
  return isSafeItemId(value) ? value : undefined;
}

function reconstructSummaryParts(
  text: string,
  state: Extract<PlaintextResponsesReasoningState, { carrier: 'summary' }>,
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
