import type { BackendSendInput, SessionEvent } from '@maka/core';
import type { RuntimeEvent } from '@maka/core/runtime-event';
import { createSessionEventMapMemory, mapSessionEventToRuntimeEvent } from '../ai-sdk-flow.js';
import type { InvocationContext } from '../invocation-context.js';

export function createDurableTurnHarness(input: {
  turnId: string;
  text: string;
  sessionId?: string;
  runId?: string;
  invocationId?: string;
}) {
  const sessionId = input.sessionId ?? 'session-1';
  const runId = input.runId ?? 'run-1';
  const invocationId = input.invocationId ?? 'invocation-1';
  let id = 0;
  let now = 1;
  const anchor: RuntimeEvent = {
    id: `runtime-user-${input.turnId}`,
    invocationId,
    runId,
    sessionId,
    turnId: input.turnId,
    ts: now++,
    partial: false,
    role: 'user',
    author: 'user',
    content: { kind: 'text', text: input.text },
  };
  const ledger: RuntimeEvent[] = [anchor];
  const memory = createSessionEventMapMemory();
  const context: InvocationContext = {
    sessionId,
    invocationId,
    runId,
    turnId: input.turnId,
    source: 'desktop',
    startedAt: anchor.ts,
    request: {
      sessionId,
      turnId: input.turnId,
      text: input.text,
      source: 'desktop',
      initialRuntimeEvent: anchor,
    },
    newId: () => `runtime-harness-${++id}`,
    now: () => now++,
  };

  return {
    anchor,
    ledger,
    loadTurnRuntimeEvents: async (turnId: string) =>
      ledger.filter((event) => event.turnId === turnId),
    sendInput: (overrides: Partial<BackendSendInput> = {}): BackendSendInput => ({
      turnId: input.turnId,
      text: input.text,
      context: [],
      headAnchorRuntimeEvent: anchor,
      ...overrides,
    }),
    record: (event: SessionEvent): void => {
      const mapped = mapSessionEventToRuntimeEvent(event, context, memory);
      if (mapped.partial !== true && mapped.content?.kind !== 'error') ledger.push(mapped);
    },
  };
}

export async function drainWithDurableTurn(
  events: AsyncIterable<SessionEvent>,
  durable: ReturnType<typeof createDurableTurnHarness>,
): Promise<SessionEvent[]> {
  const collected: SessionEvent[] = [];
  for await (const event of events) {
    durable.record(event);
    collected.push(event);
  }
  return collected;
}
