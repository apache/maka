import type { ActiveInteractionRequestEvent } from '@maka/core/events';

export type ComposerInteraction = ActiveInteractionRequestEvent;
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

/**
 * Replace a session's queue with the runtime's live set of unanswered
 * requests, keeping the order the surface already shows. The runtime owns both
 * kinds of request, so anything it no longer holds is settled and drops out.
 */
export function reconcileInteractions(
  queues: InteractionQueues,
  sessionId: string,
  liveRequests: readonly ComposerInteraction[],
): InteractionQueues {
  const liveById = new Map(liveRequests.map((request) => [request.requestId, request]));
  const seen = new Set<string>();
  const reconciled: ComposerInteraction[] = [];
  for (const interaction of queues[sessionId] ?? []) {
    const live = liveById.get(interaction.requestId);
    if (!live) continue;
    seen.add(interaction.requestId);
    reconciled.push(live);
  }
  for (const request of liveRequests) {
    if (!seen.has(request.requestId)) reconciled.push(request);
  }
  return { ...queues, [sessionId]: reconciled };
}

export function activeInteractionFor(
  queues: InteractionQueues,
  sessionId: string | undefined,
): ComposerInteraction | undefined {
  return sessionId ? queues[sessionId]?.[0] : undefined;
}
