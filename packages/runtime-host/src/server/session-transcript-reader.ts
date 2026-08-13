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

function transcriptMergeKey(message: StoredMessage): string {
  // RuntimeEvent projection deliberately gives function responses canonical
  // event ids, while the durable Session row may retain an older generated id.
  // Both rows describe the same response when they point at the same tool use.
  if (message.type === 'tool_result') {
    return `${message.type}\0${message.turnId}\0${message.toolUseId}`;
  }
  return `${message.type}\0${message.id}`;
}

export function mergeMessageUpserts(
  stored: readonly StoredMessage[],
  active: readonly StoredMessage[],
): StoredMessage[] {
  const activeKeys = new Set(active.map(transcriptMergeKey));
  const activeIndexByKey = new Map(
    active.map((message, index) => [transcriptMergeKey(message), index]),
  );
  const merged: StoredMessage[] = [];
  let activeCursor = 0;
  for (const storedMessage of stored) {
    const key = transcriptMergeKey(storedMessage);
    const activeIndex = activeIndexByKey.get(key);
    if (activeIndex !== undefined && activeIndex >= activeCursor) {
      for (const message of active.slice(activeCursor, activeIndex + 1)) {
        merged.push(structuredClone(message));
      }
      activeCursor = activeIndex + 1;
      continue;
    }
    // A matching active row that was already emitted is the same semantic
    // message under a different durable id (notably tool_result); do not show
    // it twice. Rows owned only by Session storage, such as turn_state, keep
    // their exact database position between the surrounding active anchors.
    if (!activeKeys.has(key)) {
      merged.push(structuredClone(storedMessage));
    }
  }
  for (const message of active.slice(activeCursor)) {
    merged.push(structuredClone(message));
  }
  return merged;
}

function isTerminalTurn(turn: TurnSnapshot): boolean {
  return turn.status === 'completed' || turn.status === 'failed' || turn.status === 'cancelled';
}
