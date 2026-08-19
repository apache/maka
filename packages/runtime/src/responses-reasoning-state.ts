import type { ModelMessage } from './model-protocol.js';

const STATE_KEY = 'makaResponses';
const STATE_VERSION = 1;
const MAX_ITEM_ID_LENGTH = 512;

export type PlaintextResponsesReasoningCarrier = 'content' | 'summary';

export interface PlaintextResponsesReasoningState {
  readonly version: 1;
  readonly itemId: string;
  readonly carrier: PlaintextResponsesReasoningCarrier;
}

export function plaintextResponsesReasoningProviderOptions(
  itemId: string,
  carrier: PlaintextResponsesReasoningCarrier,
): NonNullable<ModelMessage['providerOptions']> | undefined {
  if (!isSafeItemId(itemId)) return undefined;
  return {
    [STATE_KEY]: { version: STATE_VERSION, itemId, carrier },
  };
}

export function readPlaintextResponsesReasoningState(
  providerOptions: Readonly<Record<string, unknown>> | undefined,
): PlaintextResponsesReasoningState | undefined {
  const raw = providerOptions?.[STATE_KEY];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  if (
    record.version !== STATE_VERSION ||
    !isSafeItemId(record.itemId) ||
    (record.carrier !== 'content' && record.carrier !== 'summary') ||
    Object.keys(record).some((key) => !['version', 'itemId', 'carrier'].includes(key))
  ) {
    return undefined;
  }
  return {
    version: STATE_VERSION,
    itemId: record.itemId,
    carrier: record.carrier,
  };
}

export function responsesReasoningItemId(
  providerOptions: Readonly<Record<string, unknown>> | undefined,
): string | undefined {
  const plaintext = readPlaintextResponsesReasoningState(providerOptions);
  if (plaintext) return plaintext.itemId;
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
