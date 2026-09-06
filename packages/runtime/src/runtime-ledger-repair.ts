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

import { createHash } from 'node:crypto';
import { deriveTurnRecords } from '@maka/core/session';
import { DEFAULT_TOOL_MODE } from '@maka/core/tool-mode';
import { isTerminalRuntimeEvent } from '@maka/core/runtime-event';
import type { RuntimeEvent, RuntimeEventInvocationOpenedContent } from '@maka/core/runtime-event';
import type { RuntimeEventStore } from '@maka/core/runtime-event-store';
import {
  buildInvocationOpenedEvent,
  isSessionInlineInvocation,
} from '@maka/core/runtime-invocation';
import type {
  RuntimeInvocationOutcome,
  RuntimeInvocationRecord,
} from '@maka/core/runtime-invocation';
import type { SessionHeader } from '@maka/core/session';
import type { StoredMessage, TurnRecord } from '@maka/core/session';
import { backfillRuntimeEventsFromStoredMessages } from './runtime-event-backfill.js';
import type { RuntimeEventBackfillOutcome } from './runtime-event-backfill.js';
import { projectRuntimeEventUserMessage } from './runtime-event-read-model.js';

export interface RuntimeLedgerRepairDeps {
  runtimeEventStore: RuntimeEventStore;
  readMessages(sessionId: string): Promise<StoredMessage[]>;
  appendMessage(sessionId: string, message: StoredMessage): Promise<void>;
  newId: () => string;
  now: () => number;
}

interface RuntimeEventTranscriptProjectionDeps {
  readMessages(sessionId: string): Promise<StoredMessage[]>;
  appendMessage(sessionId: string, message: StoredMessage): Promise<void>;
}

export async function materializeRuntimeEventTranscriptProjection(
  deps: RuntimeEventTranscriptProjectionDeps,
  sessionId: string,
  event: RuntimeEvent,
  knownMessageIds?: Set<string>,
): Promise<boolean> {
  const message = steeringMessageFromRuntimeEvent(event);
  if (!message) return false;
  const messageIds =
    knownMessageIds ?? new Set((await deps.readMessages(sessionId)).map((item) => item.id));
  if (messageIds.has(message.id)) return false;
  await deps.appendMessage(sessionId, message);
  messageIds.add(message.id);
  return true;
}

export class RuntimeLedgerRepair {
  private readonly queues = new Map<string, Promise<void>>();

  constructor(private readonly deps: RuntimeLedgerRepairDeps) {}

  /**
   * Give an imported transcript a runtime spine: one invocation per turn, opened
   * by its own opening fact and closed by its own terminal event.
   *
   * The transcript is the only evidence there is, so a turn it cannot close is
   * refused rather than imported half-formed. Re-running is a no-op: a turn
   * whose invocation already exists is left exactly as it is.
   */
  async materializeTranscriptLedger(header: SessionHeader): Promise<void> {
    const sessionId = header.id;
    return this.withRepairQueue(sessionId, 'transcript-runs', async () => {
      const messages = await this.deps.readMessages(sessionId);
      const ledgerMessages = messages.filter(
        (message) => message.type !== 'user' || message.steeringEventId === undefined,
      );
      const openedTurnIds = new Set(
        (await this.listInlineInvocations(sessionId)).map((invocation) => invocation.turnId),
      );
      const messagesByTurn = groupMessagesByTurn(ledgerMessages);
      const turns = deriveTurnRecords(ledgerMessages).filter((turn) =>
        (messagesByTurn.get(turn.turnId) ?? []).some((message) => message.type === 'user'),
      );
      if (turns.length === 0) return;

      const firstOpenedAt = Math.max(0, header.createdAt - turns.length);

      for (const [index, turn] of turns.entries()) {
        if (openedTurnIds.has(turn.turnId)) continue;
        const turnMessages = messagesByTurn.get(turn.turnId) ?? [];
        const runId = transcriptRunId(sessionId, turn.turnId);
        const openedAt = firstOpenedAt + index;
        const run = { sessionId, runId, turnId: turn.turnId, invocationId: runId };
        const events = [
          transcriptOpeningEvent({ header, run, openedAt, newId: this.deps.newId }),
          ...backfillRuntimeEventsFromStoredMessages({
            run,
            outcome: transcriptOutcome(turn, turnMessages, openedAt),
            messages: turnMessages,
            modelHistory: 'conversation_text',
            newId: this.deps.newId,
            now: this.deps.now,
          }).events,
        ];
        if (!events.some(isTerminalRuntimeEvent)) {
          throw new Error(`Imported transcript Run ${runId} has no terminal RuntimeEvent`);
        }
        for (const event of events) {
          await this.deps.runtimeEventStore.appendRuntimeEvent(sessionId, runId, event);
        }
      }
    });
  }

  async repairSteeringMessagesOnce(sessionId: string): Promise<number> {
    return this.withRepairQueue(sessionId, 'steering-transcript', async () => {
      const messages = await this.deps.readMessages(sessionId);
      const messageIds = new Set(messages.map((message) => message.id));
      const inlineRunIds = new Set(
        (await this.listInlineInvocations(sessionId)).map((invocation) => invocation.runId),
      );
      let repaired = 0;
      for (const event of await this.deps.runtimeEventStore.readSessionRuntimeEvents(sessionId)) {
        if (!inlineRunIds.has(event.runId)) continue;
        if (
          await materializeRuntimeEventTranscriptProjection(this.deps, sessionId, event, messageIds)
        ) {
          repaired += 1;
        }
      }
      return repaired;
    });
  }

  private async listInlineInvocations(sessionId: string): Promise<RuntimeInvocationRecord[]> {
    return (await this.deps.runtimeEventStore.listSessionInvocations(sessionId)).filter(
      (invocation) => isSessionInlineInvocation(invocation.opening),
    );
  }

  private async withRepairQueue<T>(
    sessionId: string,
    runId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const key = `${sessionId}:${runId}`;
    const previous = this.queues.get(key) ?? Promise.resolve();
    const current = previous.then(operation, operation);
    const cleanup = current.then(
      () => undefined,
      () => undefined,
    );
    this.queues.set(key, cleanup);
    try {
      return await current;
    } finally {
      if (this.queues.get(key) === cleanup) {
        this.queues.delete(key);
      }
    }
  }
}

function transcriptRunId(sessionId: string, turnId: string): string {
  const digest = createHash('sha256').update(sessionId).update('\0').update(turnId).digest('hex');
  return `transcript-${digest.slice(0, 48)}`;
}

/**
 * The opening fact of an imported turn.
 *
 * Its route is `unknown` on purpose: an external transcript records which model
 * produced the text, never which credential the host would have used, so the
 * import must not let anything treat the route as authenticated.
 */
function transcriptOpeningEvent(input: {
  header: SessionHeader;
  run: { sessionId: string; runId: string; turnId: string; invocationId: string };
  openedAt: number;
  newId: () => string;
}): RuntimeEvent {
  const opening: RuntimeEventInvocationOpenedContent = {
    kind: 'invocation_opened',
    protocol: 'invocation_opened_v1',
    route: {
      provenance: 'unknown',
      backendKind: input.header.backend,
      llmConnectionSlug: input.header.llmConnectionSlug,
      modelId: input.header.model,
    },
    configuration: {
      cwd: input.header.cwd,
      permissionMode: input.header.permissionMode,
      collaborationMode: input.header.collaborationMode ?? 'agent',
      orchestrationMode: input.header.orchestrationMode ?? 'default',
      orchestrationSource: 'session',
      toolMode: DEFAULT_TOOL_MODE,
    },
    root: { kind: 'user' },
    source: { kind: 'fresh' },
  };
  return buildInvocationOpenedEvent({
    id: input.newId(),
    run: input.run,
    openedAt: input.openedAt,
    opening,
  });
}

/** How the imported turn ended, read off the transcript's own turn record. */
function transcriptOutcome(
  turn: TurnRecord,
  turnMessages: readonly StoredMessage[],
  openedAt: number,
): RuntimeEventBackfillOutcome {
  const ts = Math.max(openedAt, ...turnMessages.map((message) => message.ts));
  // A transcript that never stated how a turn ended does not get to claim it
  // completed. The terminal event is written once and cannot be corrected later,
  // so an inferred status is recorded as the failure it actually is — which is
  // also the reason an adapter emits a cutoff of its own.
  if (turn.statusSource !== 'recorded') {
    return { status: 'failed', ts, failureClass: 'missing_terminal_event' };
  }
  const status = transcriptOutcomeStatus(turn.status);
  return {
    status,
    ts,
    ...(status === 'failed'
      ? { failureClass: turn.errorClass ?? 'external_transcript_failed' }
      : {}),
    ...(status === 'cancelled'
      ? { abortSource: turn.abortSource ?? 'external_session_snapshot' }
      : {}),
  };
}

function transcriptOutcomeStatus(status: TurnRecord['status']): RuntimeInvocationOutcome {
  if (status === 'failed') return 'failed';
  if (status === 'completed') return 'completed';
  return 'cancelled';
}

function groupMessagesByTurn(messages: readonly StoredMessage[]): Map<string, StoredMessage[]> {
  const grouped = new Map<string, StoredMessage[]>();
  for (const message of messages) {
    const turnId = 'turnId' in message ? message.turnId : undefined;
    if (!turnId) continue;
    const bucket = grouped.get(turnId) ?? [];
    bucket.push(message);
    grouped.set(turnId, bucket);
  }
  return grouped;
}

function steeringMessageFromRuntimeEvent(event: RuntimeEvent): StoredMessage | undefined {
  const messageId = event.refs?.providerEventId;
  if (
    event.role !== 'user' ||
    event.content?.kind !== 'text' ||
    event.content.steering !== true ||
    typeof messageId !== 'string' ||
    messageId.length === 0
  ) {
    return undefined;
  }
  return projectRuntimeEventUserMessage(event, messageId);
}
