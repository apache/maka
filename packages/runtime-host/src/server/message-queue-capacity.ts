import type { SessionMessageQueueProjection } from '../protocol/index.js';

export function worstCaseMessageQueueProjection(
  projection: SessionMessageQueueProjection,
): SessionMessageQueueProjection {
  return {
    ...projection,
    queueRevision: Number.MAX_SAFE_INTEGER,
    steering: projection.steering.map((entry) => ({ ...entry, state: 'in_flight' as const })),
  };
}
