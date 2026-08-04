import type { ChatModelChoice, LlmConnection, SessionSummary } from '@maka/core';
import { CODEX_SUBSCRIPTION_UNSUPPORTED_CHATGPT_MODELS } from '@maka/core/codex-model-compatibility';

export type NewChatModel = { llmConnectionSlug: string; model: string };

export function pickNewChatModel(input: {
  pending: NewChatModel | null;
  activationCandidate?: NewChatModel;
  catalogDefault: NewChatModel | undefined;
  choices: readonly ChatModelChoice[];
}): NewChatModel | undefined {
  for (const candidate of [input.pending, input.activationCandidate, input.catalogDefault]) {
    if (candidate && input.choices.some(
      (choice) => choice.connectionSlug === candidate.llmConnectionSlug && choice.model === candidate.model,
    )) return candidate;
  }
  const first = input.choices[0];
  return first ? { llmConnectionSlug: first.connectionSlug, model: first.model } : undefined;
}

export function normalizeActiveChatModel(
  session: SessionSummary | undefined,
  connection: LlmConnection | undefined,
  choices: readonly ChatModelChoice[],
): string | undefined {
  if (!session || session.backend === 'fake') return undefined;
  const requested = session.model || connection?.defaultModel;
  if (choices.some(
    (choice) => choice.connectionSlug === session.llmConnectionSlug && choice.model === requested,
  )) return requested;
  if (
    connection?.providerType !== 'openai-codex' ||
    !requested ||
    !CODEX_SUBSCRIPTION_UNSUPPORTED_CHATGPT_MODELS.has(requested)
  ) return requested;
  return choices.find((choice) => choice.connectionSlug === session.llmConnectionSlug)?.model;
}

export function chatModelChoiceLabel(
  choices: readonly ChatModelChoice[],
  connectionSlug: string | undefined,
  model: string | undefined,
): string | undefined {
  if (!connectionSlug || !model) return model;
  return choices.find((choice) => choice.connectionSlug === connectionSlug && choice.model === model)?.label ?? model;
}
