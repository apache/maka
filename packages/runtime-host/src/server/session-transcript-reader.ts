/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import type { RuntimeEvent } from '@maka/core/runtime-event';
import type { StoredMessage } from '@maka/core/session';
import {
  affectsRuntimeEventStoredMessageProjection,
  isHardRuntimeEventReadModelDiagnostic,
  projectRuntimeEventsToStoredMessages,
} from '@maka/runtime/runtime-event-read-model';
import {
  type CanonicalPermissionOutcomeReader,
  type CanonicalPermissionOutcomeRecord,
} from '@maka/runtime/interaction-authority';
import type {
  ExecutionStoresWriter,
  SessionTranscriptMessageLookupRequest,
  SessionTranscriptPageRequest,
  SessionTranscriptStoragePage,
} from '@maka/storage/execution-stores';
import { SESSION_TRANSCRIPT_OVERLAY_MAX_MESSAGES, type TurnSnapshot } from '../protocol/index.js';

const PERMISSION_OUTCOME_READ_CONCURRENCY = 8;
export const ACTIVE_TRANSCRIPT_OVERLAY_MAX_MESSAGES = SESSION_TRANSCRIPT_OVERLAY_MAX_MESSAGES;
export const ACTIVE_TRANSCRIPT_OVERLAY_MAX_BYTES = 16 * 1024 * 1024;
const ACTIVE_TRANSCRIPT_SOURCE_MAX_EVENTS = ACTIVE_TRANSCRIPT_OVERLAY_MAX_MESSAGES * 2;
const ACTIVE_TRANSCRIPT_SCAN_BATCH_MAX_BYTES = 256 * 1024;

export function createSessionTranscriptReader(input: {
  stores: ExecutionStoresWriter<'interactive'>;
  canonicalPermissionOutcomes: CanonicalPermissionOutcomeReader;
}): SessionTranscriptReader {
  return {
    readDurableHighWater: (sessionId) =>
      input.stores.sessionStore.readTranscriptHighWaterSnapshot(sessionId),
    readDurablePage: (sessionId, request) =>
      input.stores.sessionStore.readTranscriptPageSnapshot(sessionId, request),
    readDurableMessagesById: (sessionId, request) =>
      input.stores.sessionStore.readTranscriptMessagesSnapshot(sessionId, request),
    readActiveOverlay: async (sessionId, rootTurn) => {
      if (!rootTurn || isTerminalTurn(rootTurn)) return [];

      const run = await input.stores.agentRunStore.readRun(sessionId, rootTurn.runId);
      const events = await readActiveProjectionEvents(input.stores, sessionId, rootTurn.runId);
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
      assertActiveOverlayBounded(projected.messages);
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
  readDurableMessagesById(
    sessionId: string,
    request: SessionTranscriptMessageLookupRequest,
  ): Promise<readonly StoredMessage[]>;
  readActiveOverlay(
    sessionId: string,
    rootTurn: TurnSnapshot | null,
  ): Promise<readonly StoredMessage[]>;
}

function assertActiveOverlayBounded(messages: readonly StoredMessage[]): void {
  if (messages.length > ACTIVE_TRANSCRIPT_OVERLAY_MAX_MESSAGES) {
    throw new Error('Active Session transcript overlay exceeds its message limit');
  }
  let encodedBytes = 0;
  for (const message of messages) {
    encodedBytes += Buffer.byteLength(JSON.stringify(message), 'utf8');
    if (encodedBytes > ACTIVE_TRANSCRIPT_OVERLAY_MAX_BYTES) {
      throw new Error('Active Session transcript overlay exceeds its byte limit');
    }
  }
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
  let encodedBytes = 0;
  for (let index = 0; index < ids.length; index += PERMISSION_OUTCOME_READ_CONCURRENCY) {
    const batch = await Promise.all(
      ids.slice(index, index + PERMISSION_OUTCOME_READ_CONCURRENCY).map(async (requestId) => ({
        requestId,
        outcome: await reader.readPermissionOutcome(requestId),
      })),
    );
    for (const item of batch) {
      if (!item.outcome) continue;
      encodedBytes += Buffer.byteLength(JSON.stringify(item.outcome), 'utf8');
      if (encodedBytes > ACTIVE_TRANSCRIPT_OVERLAY_MAX_BYTES) {
        throw new Error('Active Session permission outcomes exceed the transcript byte limit');
      }
      outcomes.set(item.requestId, item.outcome);
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

async function readActiveProjectionEvents(
  stores: ExecutionStoresWriter<'interactive'>,
  sessionId: string,
  runId: string,
): Promise<RuntimeEvent[]> {
  const events: RuntimeEvent[] = [];
  let retainedEvents = 0;
  let retainedBytes = 0;
  const result = await stores.runtimeEventStore.scanRuntimeEvents(
    sessionId,
    runId,
    {
      maxBatchBytes: ACTIVE_TRANSCRIPT_SCAN_BATCH_MAX_BYTES,
      maxRecordBytes: ACTIVE_TRANSCRIPT_OVERLAY_MAX_BYTES,
      maxImmutableRecords: ACTIVE_TRANSCRIPT_SOURCE_MAX_EVENTS,
      maxImmutableBytes: ACTIVE_TRANSCRIPT_OVERLAY_MAX_BYTES,
      maxPartialRecords: ACTIVE_TRANSCRIPT_SOURCE_MAX_EVENTS,
      maxPartialBytes: ACTIVE_TRANSCRIPT_OVERLAY_MAX_BYTES,
    },
    (batch) => {
      const relevant = batch.filter(affectsRuntimeEventStoredMessageProjection);
      for (const event of relevant) {
        retainedEvents += 1;
        retainedBytes += Buffer.byteLength(JSON.stringify(event), 'utf8');
        if (retainedEvents > ACTIVE_TRANSCRIPT_SOURCE_MAX_EVENTS) {
          throw new Error('Active RuntimeEvent transcript exceeds its event limit');
        }
        if (retainedBytes > ACTIVE_TRANSCRIPT_OVERLAY_MAX_BYTES) {
          throw new Error('Active RuntimeEvent transcript exceeds its byte limit');
        }
      }
      events.push(...relevant);
    },
  );
  if (result.status === 'limit_exceeded') {
    throw new Error('Active RuntimeEvent transcript exceeds its storage scan limit');
  }
  return events;
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
