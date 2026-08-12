import type { ChatModelChoice } from '@maka/core/chat-model-choice';

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

export function chatModelChoiceLabel(
  choices: readonly ChatModelChoice[],
  connectionSlug: string | undefined,
  model: string | undefined,
): string | undefined {
  if (!connectionSlug || !model) return model;
  return choices.find((choice) => choice.connectionSlug === connectionSlug && choice.model === model)?.label ?? model;
}
