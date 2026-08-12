import type { RuntimeEvent } from '@maka/core/runtime-event';
import type { StoredMessage } from '@maka/core/session';
import {
  isHardRuntimeEventReadModelDiagnostic,
  projectRuntimeEventsToStoredMessages,
} from '@maka/runtime/runtime-event-read-model';
import {
  type CanonicalPermissionOutcomeReader,
  type CanonicalPermissionOutcomeRecord,
} from '@maka/runtime/interaction-authority';
import type {
  ExecutionStoresWriter,
  SessionTranscriptPageRequest,
  SessionTranscriptStoragePage,
} from '@maka/storage/execution-stores';
import type { TurnSnapshot } from '../protocol/index.js';

const PERMISSION_OUTCOME_READ_CONCURRENCY = 8;

export function createSessionTranscriptReader(input: {
  stores: ExecutionStoresWriter<'interactive'>;
  canonicalPermissionOutcomes: CanonicalPermissionOutcomeReader;
}): SessionTranscriptReader {
  return {
    readDurableHighWater: (sessionId) =>
      input.stores.sessionStore.readTranscriptHighWaterSnapshot(sessionId),
    readDurablePage: (sessionId, request) =>
      input.stores.sessionStore.readTranscriptPageSnapshot(sessionId, request),
    readActiveOverlay: async (sessionId, rootTurn) => {
      if (!rootTurn || isTerminalTurn(rootTurn)) return [];

      const [run, events] = await Promise.all([
        input.stores.agentRunStore.readRun(sessionId, rootTurn.runId),
        input.stores.runtimeEventStore.readRuntimeEvents(sessionId, rootTurn.runId),
      ]);
      const canonicalPermissionOutcomes = await readCanonicalPermissionOutcomes(
        events,
        input.canonicalPermissionOutcomes,
      );
      const projected = projectRuntimeEventsToStoredMessages(activePresentationEvents(events), {
        runHeaders: [run],
        canonicalPermissionOutcomes,
      });
      if (projected.diagnostics.some(isHardRuntimeEventReadModelDiagnostic)) {
        throw new Error('Active RuntimeEvent transcript projection is incomplete');
      }
      return projected.messages;
    },
  };
}

export interface SessionTranscriptReader {
  readDurableHighWater(sessionId: string): Promise<number | null>;
  readDurablePage(
    sessionId: string,
    request: SessionTranscriptPageRequest,
  ): Promise<SessionTranscriptStoragePage>;
  readActiveOverlay(
    sessionId: string,
    rootTurn: TurnSnapshot | null,
  ): Promise<readonly StoredMessage[]>;
}

async function readCanonicalPermissionOutcomes(
  events: readonly RuntimeEvent[],
  reader: CanonicalPermissionOutcomeReader,
): Promise<ReadonlyMap<string, CanonicalPermissionOutcomeRecord>> {
  const requestIds = new Set(
    events.flatMap((event) => {
      const requestId = event.actions?.permissionAnswerAccepted?.requestId;
      return requestId ? [requestId] : [];
    }),
  );
  const outcomes = new Map<string, CanonicalPermissionOutcomeRecord>();
  const ids = [...requestIds];
  for (let index = 0; index < ids.length; index += PERMISSION_OUTCOME_READ_CONCURRENCY) {
    const batch = await Promise.all(
      ids.slice(index, index + PERMISSION_OUTCOME_READ_CONCURRENCY).map(async (requestId) => ({
        requestId,
        outcome: await reader.readPermissionOutcome(requestId),
      })),
    );
    for (const item of batch) {
      if (item.outcome) outcomes.set(item.requestId, item.outcome);
    }
  }
  return outcomes;
}

function activePresentationEvents(events: readonly RuntimeEvent[]): RuntimeEvent[] {
  const textMessages = new Set<string>();
  const lastThinkingByMessage = new Map<string, RuntimeEvent>();

  for (const event of events) {
    const content = event.content;
    if (event.role !== 'model' || (content?.kind !== 'text' && content?.kind !== 'thinking')) {
      continue;
    }
    const messageKey = activeMessageKey(event);
    if (content.kind === 'text') textMessages.add(messageKey);
    else lastThinkingByMessage.set(messageKey, event);
  }

  const syntheticAfter = new Map<RuntimeEvent, RuntimeEvent[]>();
  for (const [messageKey, thinking] of lastThinkingByMessage) {
    if (textMessages.has(messageKey)) continue;
    const existing = syntheticAfter.get(thinking) ?? [];
    existing.push(emptyAssistantText(thinking));
    syntheticAfter.set(thinking, existing);
  }

  const presented: RuntimeEvent[] = [];
  for (const event of events) {
    presented.push(presentationEvent(event));
    const synthetic = syntheticAfter.get(event);
    if (synthetic) presented.push(...synthetic);
  }
  return presented;
}

function activeMessageKey(event: RuntimeEvent): string {
  const messageId = event.refs?.providerEventId ?? event.refs?.storedMessageId ?? event.id;
  return `${event.runId}\0${messageId}`;
}

function presentationEvent(event: RuntimeEvent): RuntimeEvent {
  const content = event.content;
  return event.partial &&
    event.role === 'model' &&
    (content?.kind === 'text' || content?.kind === 'thinking')
    ? { ...event, partial: false }
    : event;
}

function emptyAssistantText(thinking: RuntimeEvent): RuntimeEvent {
  return {
    ...thinking,
    id: `${thinking.id}:active-transcript-empty-text`,
    partial: false,
    content: { kind: 'text', text: '' },
  };
}

function isTerminalTurn(turn: TurnSnapshot): boolean {
  return turn.status === 'completed' || turn.status === 'failed' || turn.status === 'cancelled';
}
