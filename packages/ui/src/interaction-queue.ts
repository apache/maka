import type {
  SandboxBoundaryRequestEvent,
  UserQuestionRequestEvent,
} from '@maka/core';

export type ComposerInteraction =
  | SandboxBoundaryRequestEvent
  | UserQuestionRequestEvent;
export type InteractionQueues = Record<string, ComposerInteraction[]>;

export function enqueueInteraction(
  queues: InteractionQueues,
  sessionId: string,
  interaction: ComposerInteraction,
): InteractionQueues {
  const queue = queues[sessionId] ?? [];
  if (queue.some((candidate) => candidate.requestId === interaction.requestId)) return queues;
  return { ...queues, [sessionId]: [...queue, interaction] };
}

export function dequeueInteractionByRequestId(
  queues: InteractionQueues,
  sessionId: string,
  requestId: string,
): InteractionQueues {
  const queue = queues[sessionId];
  if (!queue?.some((interaction) => interaction.requestId === requestId)) return queues;
  return { ...queues, [sessionId]: queue.filter((interaction) => interaction.requestId !== requestId) };
}

export function dequeueInteractionByToolUseId(
  queues: InteractionQueues,
  sessionId: string,
  toolUseId: string,
): InteractionQueues {
  const queue = queues[sessionId];
  if (!queue?.some((interaction) => interaction.toolUseId === toolUseId)) return queues;
  return { ...queues, [sessionId]: queue.filter((interaction) => interaction.toolUseId !== toolUseId) };
}

export function clearInteractions(queues: InteractionQueues, sessionId: string): InteractionQueues {
  if (!queues[sessionId]?.length) return queues;
  return { ...queues, [sessionId]: [] };
}

export function activeInteractionFor(
  queues: InteractionQueues,
  sessionId: string | undefined,
): ComposerInteraction | undefined {
  return sessionId ? queues[sessionId]?.[0] : undefined;
}
