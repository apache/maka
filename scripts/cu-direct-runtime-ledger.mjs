import {
  createSessionEventMapMemory,
  mapSessionEventToRuntimeEvent,
} from '../packages/runtime/dist/index.js';

export function createDirectRuntimeTurnLedger({ sessionId, turnId, text, newId, now }) {
  const invocationId = `${sessionId}-invocation`;
  const runId = `${sessionId}-run`;
  const anchor = {
    id: newId(),
    invocationId,
    runId,
    sessionId,
    turnId,
    ts: now(),
    partial: false,
    role: 'user',
    author: 'user',
    content: { kind: 'text', text },
  };
  const events = [anchor];
  const memory = createSessionEventMapMemory();
  const context = {
    sessionId,
    invocationId,
    runId,
    turnId,
    source: 'desktop',
    startedAt: anchor.ts,
    request: {
      sessionId,
      turnId,
      text,
      source: 'desktop',
      initialRuntimeEvent: anchor,
    },
    newId,
    now,
  };

  return {
    anchor,
    loadTurnRuntimeEvents: async (requestedTurnId) =>
      events.filter((event) => event.turnId === requestedTurnId),
    record(sessionEvent) {
      const event = mapSessionEventToRuntimeEvent(sessionEvent, context, memory);
      if (event.partial !== true && event.content?.kind !== 'error') events.push(event);
    },
  };
}
