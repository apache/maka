import type { ModelMessage } from './model-protocol.js';

const STATE_KEY = 'makaResponses';
const STATE_VERSION = 1;
const MAX_ITEM_ID_LENGTH = 512;
const MAX_PROFILE_LENGTH = 128;

export type PlaintextResponsesReasoningCarrier = 'content' | 'summary';

export interface PlaintextResponsesReasoningState {
  readonly version: 1;
  readonly profile: string;
  readonly itemId: string;
  readonly carrier: PlaintextResponsesReasoningCarrier;
}

export type PlaintextResponsesReasoningStateDecodeResult =
  | { readonly kind: 'missing' }
  | { readonly kind: 'malformed'; readonly profile?: string }
  | { readonly kind: 'valid'; readonly state: PlaintextResponsesReasoningState };

export function plaintextResponsesReasoningProviderOptions(
  itemId: string,
  carrier: PlaintextResponsesReasoningCarrier,
  profile: string,
): NonNullable<ModelMessage['providerOptions']> | undefined {
  if (!isSafeItemId(itemId) || !isSafeProfile(profile)) return undefined;
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
  if (
    record.version !== STATE_VERSION ||
    !profile ||
    !isSafeItemId(record.itemId) ||
    (record.carrier !== 'content' && record.carrier !== 'summary') ||
    Object.keys(record).some((key) => !['version', 'profile', 'itemId', 'carrier'].includes(key))
  ) {
    return { kind: 'malformed', ...(profile ? { profile } : {}) };
  }
  return {
    kind: 'valid',
    state: {
      version: STATE_VERSION,
      profile,
      itemId: record.itemId,
      carrier: record.carrier,
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
      reasoningSummary:
        input.state.carrier === 'summary' ? [{ type: 'summary_text', text: input.text }] : [],
      // Presence is meaningful to @ai-sdk/open-responses: null prevents its
      // fallback from copying the canonical text into content when the
      // provider replays reasoning through summary instead.
      reasoningContent:
        input.state.carrier === 'content' ? [{ type: 'reasoning_text', text: input.text }] : null,
    },
  };
}

function isSafeItemId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_ITEM_ID_LENGTH &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

function isSafeProfile(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_PROFILE_LENGTH &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}
