import type { RuntimeEvent } from '@maka/core/runtime-event';
import type { StoredMessage } from '@maka/core/session';
import {
  isHardRuntimeEventReadModelDiagnostic,
  projectRuntimeEventsToStoredMessages,
  type CanonicalPermissionOutcomeReader,
  type CanonicalPermissionOutcomeRecord,
} from '@maka/runtime';
import type { ExecutionStoresWriter } from '@maka/storage/execution-stores';
import type { TurnSnapshot } from '../protocol/index.js';
import type { ReadSessionTranscript } from './session-continuity-coordinator.js';

const PERMISSION_OUTCOME_READ_CONCURRENCY = 8;

export function createSessionTranscriptReader(input: {
  stores: ExecutionStoresWriter<'interactive'>;
  canonicalPermissionOutcomes: CanonicalPermissionOutcomeReader;
}): ReadSessionTranscript {
  return async (sessionId, rootTurn) => {
    const stored = await input.stores.sessionStore.readMessagesSnapshot(sessionId);
    if (!rootTurn || isTerminalTurn(rootTurn)) return stored;

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
    return mergeMessageUpserts(stored, projected.messages);
  };
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

function mergeMessageUpserts(
  stored: readonly StoredMessage[],
  active: readonly StoredMessage[],
): StoredMessage[] {
  const merged = stored.map((message) => structuredClone(message));
  const indices = new Map(merged.map((message, index) => [message.id, index]));
  for (const message of active) {
    const index = indices.get(message.id);
    if (index === undefined) {
      indices.set(message.id, merged.length);
      merged.push(structuredClone(message));
    } else {
      merged[index] = structuredClone(message);
    }
  }
  return merged;
}

function isTerminalTurn(turn: TurnSnapshot): boolean {
  return turn.status === 'completed' || turn.status === 'failed' || turn.status === 'cancelled';
}
