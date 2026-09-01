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

import { isDeepStrictEqual } from 'node:util';
import type { ActiveInteractionRequestEvent, SessionEvent } from '@maka/core/events';
import type { StoredMessage, TurnRecord } from '@maka/core/session';
import type {
  InteractionPendingSnapshot,
  SessionContinuitySnapshot,
  SessionAssistantDelta,
  SessionAssistantStreamIdentity,
  SessionMessageQueueProjection,
  SessionSteeringEvent,
  SteeringMessageSnapshot,
  SubscriptionFrame,
  LiveTurnSnapshot,
  TurnSnapshot,
} from '../protocol/index.js';

interface AssistantAccumulator {
  kind: 'text' | 'thinking';
  turnId: string;
  messageId: string;
  text: string;
  complete: boolean;
  replacing: boolean;
}

export interface RuntimeHostSessionProjectionSeed {
  readonly durableSteeringMessages: readonly {
    readonly messageId: string;
    readonly turnId: string;
  }[];
  readonly activeAssistantMessages: readonly Extract<StoredMessage, { type: 'assistant' }>[];
}

export function createRuntimeHostSessionProjectionSeed(
  transcript: readonly StoredMessage[],
  snapshot: SessionContinuitySnapshot,
): RuntimeHostSessionProjectionSeed {
  return {
    durableSteeringMessages: transcript
      .filter(
        (message): message is Extract<StoredMessage, { type: 'user' }> =>
          message.type === 'user' && message.steeringEventId !== undefined,
      )
      .map((message) => ({ messageId: message.id, turnId: message.turnId })),
    activeAssistantMessages:
      snapshot.rootTurn === null
        ? []
        : transcript.filter(
            (message): message is Extract<StoredMessage, { type: 'assistant' }> =>
              message.type === 'assistant' && message.turnId === snapshot.rootTurn?.turnId,
          ),
  };
}

export type RuntimeHostTerminalTurn = Extract<
  TurnSnapshot,
  { status: 'completed' } | { status: 'failed' } | { status: 'cancelled' }
>;

export interface RuntimeHostProjectionUpdate {
  readonly events: readonly SessionEvent[];
  readonly previousSnapshot?: SessionContinuitySnapshot;
  readonly startedTurn?: TurnSnapshot;
  readonly terminalTurn?: RuntimeHostTerminalTurn;
  readonly resolvedInteractions: readonly InteractionPendingSnapshot[];
}

export class RuntimeHostSessionProjector {
  #snapshot: SessionContinuitySnapshot;
  readonly #now: () => number;
  readonly #durableSteeringTurnByMessage: Map<string, string>;
  // Only live/synthesized messages for the current root belong here. Durable
  // transcript identity stays in the admission map above, so this render
  // ledger cannot grow with the lifetime of the session.
  readonly #renderedSteeringMessageIds = new Set<string>();
  readonly #accumulators = new Map<string, AssistantAccumulator>();
  #projectMessageAdmissions: boolean;

  constructor(
    snapshot: SessionContinuitySnapshot,
    seed: RuntimeHostSessionProjectionSeed,
    now: () => number = Date.now,
    activeAssistantStreams: readonly SessionAssistantStreamIdentity[] = [],
    projectMessageAdmissions = false,
  ) {
    this.#snapshot = structuredClone(snapshot);
    this.#now = now;
    this.#durableSteeringTurnByMessage = new Map(
      seed.durableSteeringMessages.map(({ messageId, turnId }) => [messageId, turnId]),
    );
    this.#projectMessageAdmissions = projectMessageAdmissions;
    const root = snapshot.rootTurn;
    if (!root) return;
    for (const message of seed.activeAssistantMessages) {
      if (message.turnId !== root.turnId) continue;
      if (message.thinking?.text) {
        this.#accumulators.set(accumulatorKey('thinking', message.id), {
          kind: 'thinking',
          turnId: root.turnId,
          messageId: message.id,
          text: message.thinking.text,
          complete: true,
          replacing: false,
        });
      }
      if (message.text) {
        this.#accumulators.set(accumulatorKey('text', message.id), {
          kind: 'text',
          turnId: root.turnId,
          messageId: message.id,
          text: message.text,
          complete: true,
          replacing: false,
        });
      }
    }
    for (const stream of activeAssistantStreams) {
      if (stream.turnId !== root.turnId) continue;
      const key = accumulatorKey(stream.kind, stream.messageId);
      const current = this.#accumulators.get(key);
      this.#accumulators.set(key, {
        kind: stream.kind,
        turnId: stream.turnId,
        messageId: stream.messageId,
        text: current?.text ?? '',
        complete: false,
        replacing: false,
      });
    }
  }

  get snapshot(): SessionContinuitySnapshot {
    return structuredClone(this.#snapshot);
  }

  enableMessageAdmissions(): void {
    this.#projectMessageAdmissions = true;
  }

  seedActive(includeAssistantText: boolean): SessionEvent[] {
    const root = this.#snapshot.rootTurn;
    if (!root) return [];
    const events: SessionEvent[] = [];
    if (this.#projectMessageAdmissions) {
      events.push(
        ...projectMessageAdmissionEvents(
          root,
          [...this.#durableSteeringTurnByMessage]
            .filter(([, turnId]) => turnId === root.turnId)
            .map(([messageId]) => messageId),
          this.#now(),
        ),
      );
    }
    if (isRuntimeHostTerminalTurn(root)) return events;
    let seededAssistantText = false;
    if (includeAssistantText) {
      for (const accumulator of this.#accumulators.values()) {
        if (accumulator.complete) continue;
        seededAssistantText = true;
        events.push({
          type: accumulator.kind === 'text' ? 'text_delta' : 'thinking_delta',
          id: `host-seed:${root.runId}:${accumulator.kind}:${accumulator.messageId}`,
          turnId: accumulator.turnId,
          messageId: accumulator.messageId,
          ts: this.#now(),
          startOffset: 0,
          text: accumulator.text,
        });
      }
    }
    if (root.providerRetry && !seededAssistantText) {
      events.push(providerRetryEvent(root, this.#now()));
    }
    for (const interaction of this.#snapshot.interactions.pending) {
      events.push(...projectRuntimeHostInteractionRequest(interaction, this.#now()));
    }
    for (const entry of rootQueueInFlight(this.#snapshot.queue)) {
      if (
        this.#durableSteeringTurnByMessage.has(entry.messageId) ||
        this.#renderedSteeringMessageIds.has(entry.messageId)
      )
        continue;
      this.#renderedSteeringMessageIds.add(entry.messageId);
      events.push({
        type: 'steering_message',
        id: `host-queue:${this.#snapshot.queue.hostEpoch}:${this.#snapshot.queue.queueRevision}:${entry.entryId}`,
        turnId: root.turnId,
        messageId: entry.messageId,
        ts: this.#now(),
        content: structuredClone(entry.content),
      });
    }
    if (queueHasEntries(this.#snapshot.queue)) {
      events.push(projectQueueUpdate(this.#snapshot.queue, root.turnId, this.#now()));
    }
    return events;
  }

  noteDurableTranscriptMessages(messages: readonly StoredMessage[]): SessionEvent[] {
    const events: SessionEvent[] = [];
    for (const message of messages) {
      if (message.type !== 'user' || message.steeringEventId === undefined) continue;
      const previousTurnId = this.#durableSteeringTurnByMessage.get(message.id);
      this.#durableSteeringTurnByMessage.set(message.id, message.turnId);
      if (!this.#projectMessageAdmissions || previousTurnId === message.turnId) continue;
      events.push({
        type: 'message_admission',
        id: `host-admission:${message.steeringEventId}`,
        turnId: message.turnId,
        ts: this.#now(),
        messageId: message.id,
        outcome: 'admitted',
      });
    }
    return events;
  }

  seedTerminal(turn: RuntimeHostTerminalTurn): SessionEvent[] {
    return this.#terminalEvents(turn, true);
  }

  seedStoredTerminal(turnId: string, transcript: readonly StoredMessage[]): SessionEvent[] {
    const terminal = [...transcript]
      .reverse()
      .find(
        (message): message is Extract<StoredMessage, { type: 'turn_state' }> =>
          message.type === 'turn_state' &&
          message.turnId === turnId &&
          message.status !== 'running',
      );
    if (!terminal) return [];
    const events: SessionEvent[] = [];
    for (const message of transcript) {
      if (message.type !== 'assistant' || message.turnId !== turnId) continue;
      if (message.thinking?.text) {
        events.push({
          type: 'thinking_complete',
          id: `${terminal.id}:thinking:${message.id}`,
          turnId,
          messageId: message.id,
          ts: terminal.ts,
          text: message.thinking.text,
        });
      }
      if (message.text) {
        events.push({
          type: 'text_complete',
          id: `${terminal.id}:text:${message.id}`,
          turnId,
          messageId: message.id,
          ts: terminal.ts,
          text: message.text,
        });
      }
    }
    if (terminal.status === 'completed') {
      events.push({
        type: 'complete',
        id: terminal.id,
        turnId,
        ts: terminal.ts,
        stopReason: 'end_turn',
      });
    } else if (terminal.status === 'failed') {
      const reason = terminal.errorClass ?? 'runtime_error';
      events.push({
        type: 'error',
        id: terminal.id,
        turnId,
        ts: terminal.ts,
        recoverable: false,
        reason,
        message: `Turn failed: ${reason}`,
      });
    } else {
      events.push({
        type: 'abort',
        id: terminal.id,
        turnId,
        ts: terminal.ts,
        reason: abortReason(terminal.abortSource ?? ''),
      });
    }
    return events;
  }

  seedRecordedTerminal(turn: TurnRecord): SessionEvent[] {
    if (turn.statusSource !== 'recorded' || turn.status === 'running') return [];
    const ts = this.#now();
    const id = `host-recorded-terminal:${turn.turnId}:${turn.status}`;
    if (turn.status === 'completed') {
      return [
        {
          type: 'complete',
          id,
          turnId: turn.turnId,
          ts,
          stopReason: 'end_turn',
        },
      ];
    }
    if (turn.status === 'failed') {
      const reason = turn.errorClass ?? 'runtime_error';
      return [
        {
          type: 'error',
          id,
          turnId: turn.turnId,
          ts,
          recoverable: false,
          reason,
          message: `Turn failed: ${reason}`,
        },
      ];
    }
    return [
      {
        type: 'abort',
        id,
        turnId: turn.turnId,
        ts,
        reason: abortReason(turn.abortSource ?? ''),
      },
    ];
  }

  accept(frame: SubscriptionFrame): RuntimeHostProjectionUpdate {
    const events: SessionEvent[] = [];
    if (frame.kind === 'subscription.session_delta') {
      const delta = frame.delta;
      const key = accumulatorKey(delta.kind, delta.messageId);
      const current = this.#accumulators.get(key);
      const folded = foldRuntimeHostAssistantDelta(delta.reset ? '' : (current?.text ?? ''), delta);
      const replacing = delta.reset === true || (current?.replacing ?? false);
      this.#accumulators.set(key, {
        kind: delta.kind,
        turnId: delta.turnId,
        messageId: delta.messageId,
        text: folded.text,
        complete: delta.complete === true,
        replacing: delta.complete === true ? false : replacing,
      });
      if (delta.complete === true) {
        events.push({
          type: delta.kind === 'text' ? 'text_complete' : 'thinking_complete',
          id: frameIdentity(frame),
          turnId: delta.turnId,
          messageId: delta.messageId,
          ts: this.#now(),
          text: folded.text,
        });
      } else if (folded.tail && !replacing) {
        events.push({
          type: delta.kind === 'text' ? 'text_delta' : 'thinking_delta',
          id: frameIdentity(frame),
          turnId: delta.turnId,
          messageId: delta.messageId,
          ts: this.#now(),
          startOffset: folded.text.length - folded.tail.length,
          text: folded.tail,
        });
      }
      return emptyUpdate(events);
    }
    if (frame.kind === 'subscription.session_event') {
      const event = projectSessionEvent(frame);
      if (event.type === 'steering_message') {
        if (
          this.#durableSteeringTurnByMessage.has(event.messageId) ||
          this.#renderedSteeringMessageIds.has(event.messageId)
        ) {
          return emptyUpdate(events);
        }
        this.#renderedSteeringMessageIds.add(event.messageId);
      }
      events.push(event);
      return emptyUpdate(events);
    }
    if (frame.kind !== 'subscription.session_projection') return emptyUpdate(events);

    const previousSnapshot = this.#snapshot;
    const next = frame.snapshot;
    this.#snapshot = structuredClone(next);
    const resolvedInteractions = removedPendingInteractions(previousSnapshot, next);
    const previousRoot = previousSnapshot.rootTurn;
    const root = next.rootTurn;
    const startedTurn =
      root && (!previousRoot || root.runId !== previousRoot.runId) ? root : undefined;
    if (startedTurn) this.#renderedSteeringMessageIds.clear();
    for (const interaction of newlyPendingInteractions(previousSnapshot, next)) {
      events.push(...projectRuntimeHostInteractionRequest(interaction, this.#now()));
    }
    const enteredActiveTurn =
      root && queueChanged(previousSnapshot.queue, next.queue)
        ? newlyInFlight(previousSnapshot.queue, next.queue)
        : [];
    if (this.#projectMessageAdmissions) {
      events.push(...projectMessageRetractionEvents(previousSnapshot, next, this.#now()));
    }
    if (root && queueChanged(previousSnapshot.queue, next.queue)) {
      for (const entry of enteredActiveTurn) {
        if (
          this.#durableSteeringTurnByMessage.has(entry.messageId) ||
          this.#renderedSteeringMessageIds.has(entry.messageId)
        )
          continue;
        this.#renderedSteeringMessageIds.add(entry.messageId);
        events.push({
          type: 'steering_message',
          id: `host-queue:${next.queue.hostEpoch}:${next.queue.queueRevision}:${entry.entryId}`,
          turnId: root.turnId,
          messageId: entry.messageId,
          ts: this.#now(),
          content: structuredClone(entry.content),
        });
      }
      events.push(projectQueueUpdate(next.queue, root.turnId, this.#now()));
    }
    if (startedTurn) this.#accumulators.clear();
    const retry = liveProviderRetryEvent(previousRoot, root, this.#now());
    if (retry) events.push(retry);
    const terminalTurn =
      root && isRuntimeHostTerminalTurn(root) && !sameRuntimeHostTerminalTurn(previousRoot, root)
        ? root
        : undefined;
    if (terminalTurn) events.push(...this.#terminalEvents(terminalTurn));
    return {
      events,
      previousSnapshot,
      startedTurn,
      terminalTurn,
      resolvedInteractions,
    };
  }

  #terminalEvents(root: RuntimeHostTerminalTurn, includeSettled = false): SessionEvent[] {
    const events: SessionEvent[] = [];
    for (const accumulator of this.#accumulators.values()) {
      if (accumulator.turnId !== root.turnId || (!includeSettled && accumulator.complete)) continue;
      events.push({
        type: accumulator.kind === 'text' ? 'text_complete' : 'thinking_complete',
        id: `${root.terminalEventId}:${accumulator.kind}:${accumulator.messageId}`,
        turnId: root.turnId,
        messageId: accumulator.messageId,
        ts: this.#now(),
        text: accumulator.text,
      });
    }
    if (root.status === 'completed') {
      events.push({
        type: 'complete',
        id: root.terminalEventId,
        turnId: root.turnId,
        ts: this.#now(),
        stopReason: 'end_turn',
      });
    } else if (root.status === 'failed') {
      events.push({
        type: 'error',
        id: root.terminalEventId,
        turnId: root.turnId,
        ts: this.#now(),
        recoverable: false,
        reason: root.failureClass,
        message: root.failureMessage ?? `Turn failed: ${root.failureClass}`,
        ...(root.contextBudgetExhaustedDetail
          ? { details: { contextBudgetExhaustedDetail: root.contextBudgetExhaustedDetail } }
          : {}),
      });
    } else {
      events.push({
        type: 'abort',
        id: root.terminalEventId,
        turnId: root.turnId,
        ts: this.#now(),
        reason: abortReason(root.abortSource),
      });
    }
    return events;
  }
}

function emptyUpdate(events: readonly SessionEvent[]): RuntimeHostProjectionUpdate {
  return { events, resolvedInteractions: [] };
}

function projectMessageAdmissionEvents(
  root: TurnSnapshot,
  messageIds: readonly string[],
  ts: number,
): SessionEvent[] {
  return messageIds.map((messageId) => ({
    type: 'message_admission' as const,
    id: `host-admission:${root.runId}:${messageId}`,
    turnId: root.turnId,
    ts,
    messageId,
    outcome: 'admitted' as const,
  }));
}

function projectMessageRetractionEvents(
  previous: SessionContinuitySnapshot,
  next: SessionContinuitySnapshot,
  ts: number,
): SessionEvent[] {
  const root = next.rootTurn ?? previous.rootTurn;
  if (!root || previous.queue.hostEpoch !== next.queue.hostEpoch) return [];
  const retained = new Set(
    [...next.queue.steering, ...next.queue.followup].map((entry) => entry.messageId),
  );
  return [...previous.queue.steering, ...previous.queue.followup]
    .filter((entry) => entry.state === 'queued' && !retained.has(entry.messageId))
    .map((entry) => ({
      type: 'message_admission' as const,
      id: `host-retraction:${next.queue.hostEpoch}:${next.queue.queueRevision}:${entry.messageId}`,
      turnId: root.turnId,
      ts,
      messageId: entry.messageId,
      outcome: 'retracted' as const,
    }));
}

export function projectRuntimeHostInteractionRequest(
  interaction: InteractionPendingSnapshot,
  now: number,
): ActiveInteractionRequestEvent[] {
  const base = {
    id: `host-interaction:${interaction.interactionId}:${interaction.revision}`,
    turnId: interaction.turnId,
    ts: now,
    requestId: interaction.interactionId,
    toolUseId:
      interaction.request.kind === 'sandbox_boundary'
        ? interaction.interactionId
        : interaction.request.toolUseId,
  };
  if (interaction.request.kind === 'question') {
    return [
      {
        type: 'user_question_request',
        ...base,
        questions: interaction.request.questions.map((question) => ({
          question: question.question,
          options: question.options.map((option) => ({ ...option })),
        })),
      },
    ];
  }
  if (interaction.request.kind === 'sandbox_boundary') {
    return [
      {
        type: 'sandbox_boundary_request',
        ...base,
        justification: interaction.request.justification,
        expansion: interaction.request.expansion,
      },
    ];
  }
  if (interaction.request.kind === 'client_capability') {
    return [
      {
        type: 'client_capability_request',
        ...base,
        capability: interaction.request.target.capability,
        scope: structuredClone(interaction.request.target.scope),
      },
    ];
  }
  return [];
}

function projectSessionEvent(
  frame: Extract<SubscriptionFrame, { kind: 'subscription.session_event' }>,
): SessionEvent {
  const event = frame.event;
  if (event.type === 'steering_message') {
    const steering: SessionSteeringEvent = {
      type: 'steering_message',
      id: event.id,
      turnId: event.turnId,
      ts: event.ts,
      messageId: event.messageId,
      content: structuredClone(event.content),
    };
    return steering;
  }
  const base = {
    id: event.id,
    turnId: event.turnId,
    ts: event.ts,
    toolUseId: event.toolUseId,
  };
  if (event.type === 'tool_start') {
    return {
      type: 'tool_start',
      ...base,
      toolName: event.toolName,
      args: undefined,
      ...(event.operationId ? { operationId: event.operationId } : {}),
      ...(event.activityKind ? { activityKind: event.activityKind } : {}),
      ...(event.displayName ? { displayName: event.displayName } : {}),
      ...(event.intent ? { intent: event.intent } : {}),
      ...(event.argsPreview !== undefined
        ? { argsPreview: structuredClone(event.argsPreview) }
        : {}),
      ...(event.stepId ? { stepId: event.stepId } : {}),
      ...(event.shellRunRef ? { shellRunRef: event.shellRunRef } : {}),
    };
  }
  if (event.type === 'tool_output_delta') {
    return {
      type: event.type,
      ...base,
      sessionId: frame.sessionId,
      toolCallId: event.toolUseId,
      seq: event.seq,
      stream: event.stream,
      chunk: event.chunk,
      redacted: event.redacted,
      createdAt: event.createdAt,
    };
  }
  if (event.type === 'tool_progress') return { type: event.type, ...base, chunk: event.chunk };
  if (event.type === 'tool_result_preview') {
    return {
      type: 'tool_result_preview',
      ...base,
      isError: event.isError,
      content: structuredClone(event.content),
    };
  }
  return {
    type: 'tool_result',
    ...base,
    contentOmitted: true,
    isError: event.status === 'errored',
    content: {
      kind: 'text',
      text: '',
      ...(event.sandboxFailureReason
        ? { sandboxFailure: { reason: event.sandboxFailureReason } }
        : {}),
    },
    ...(event.operationId ? { operationId: event.operationId } : {}),
    ...(event.durationMs === undefined ? {} : { durationMs: event.durationMs }),
  };
}

export function foldRuntimeHostAssistantDelta(
  current: string,
  delta: Pick<SessionAssistantDelta, 'startOffset' | 'text'>,
): { text: string; tail: string } {
  if (delta.startOffset > current.length) throw new Error('Runtime Host assistant delta has a gap');
  const overlapLength = Math.min(current.length - delta.startOffset, delta.text.length);
  if (
    overlapLength > 0 &&
    current.slice(delta.startOffset, delta.startOffset + overlapLength) !==
      delta.text.slice(0, overlapLength)
  ) {
    throw new Error('Runtime Host assistant delta conflicts with prior output');
  }
  const tail = delta.text.slice(overlapLength);
  return { text: current + tail, tail };
}

function newlyPendingInteractions(
  previous: SessionContinuitySnapshot,
  next: SessionContinuitySnapshot,
): InteractionPendingSnapshot[] {
  const previousIds = new Set(
    previous.interactions.pending.map((interaction) => interaction.interactionId),
  );
  return next.interactions.pending.filter(
    (interaction) => !previousIds.has(interaction.interactionId),
  );
}

function removedPendingInteractions(
  previous: SessionContinuitySnapshot,
  next: SessionContinuitySnapshot,
): InteractionPendingSnapshot[] {
  const nextIds = new Set(
    next.interactions.pending.map((interaction) => interaction.interactionId),
  );
  return previous.interactions.pending.filter(
    (interaction) => !nextIds.has(interaction.interactionId),
  );
}

function queueChanged(
  previous: SessionMessageQueueProjection,
  next: SessionMessageQueueProjection,
): boolean {
  return previous.hostEpoch !== next.hostEpoch || previous.queueRevision !== next.queueRevision;
}

function newlyInFlight(
  previous: SessionMessageQueueProjection,
  next: SessionMessageQueueProjection,
): Extract<SteeringMessageSnapshot, { state: 'in_flight' }>[] {
  const previousIds = new Set(rootQueueInFlight(previous).map((entry) => entry.entryId));
  return rootQueueInFlight(next).filter((entry) => !previousIds.has(entry.entryId));
}

function rootQueueInFlight(
  queue: SessionMessageQueueProjection,
): Extract<SteeringMessageSnapshot, { state: 'in_flight' }>[] {
  return queue.steering.filter(
    (entry): entry is Extract<SteeringMessageSnapshot, { state: 'in_flight' }> =>
      entry.state === 'in_flight',
  );
}

function queueHasEntries(queue: SessionMessageQueueProjection): boolean {
  return queue.steering.length > 0 || queue.followup.length > 0;
}

function projectQueueUpdate(
  queue: SessionMessageQueueProjection,
  turnId: string,
  now: number,
): Extract<SessionEvent, { type: 'queue_update' }> {
  return {
    type: 'queue_update',
    id: `host-queue:${queue.hostEpoch}:${queue.queueRevision}`,
    turnId,
    ts: now,
    queueRevision: queue.queueRevision,
    steering: queue.steering.map((entry) => entry.content.text),
    followup: queue.followup.map((entry) => entry.content.text),
    steeringEntries: queue.steering.map((entry) => ({
      entryId: entry.entryId,
      messageId: entry.messageId,
      content: structuredClone(entry.content),
      placement: entry.placement,
      state: entry.state,
    })),
    followupEntries: queue.followup.map((entry) => ({
      entryId: entry.entryId,
      messageId: entry.messageId,
      content: structuredClone(entry.content),
      placement: entry.placement,
      state: entry.state,
    })),
  };
}

function accumulatorKey(kind: 'text' | 'thinking', messageId: string): string {
  return `${kind}\0${messageId}`;
}

function frameIdentity(frame: SubscriptionFrame): string {
  return `host-frame:${frame.hostEpoch}:${frame.subscriptionId}:${frame.sequence}`;
}

export function isRuntimeHostTerminalTurn(turn: TurnSnapshot): turn is RuntimeHostTerminalTurn {
  return turn.status === 'completed' || turn.status === 'failed' || turn.status === 'cancelled';
}

export function sameRuntimeHostTerminalTurn(
  previous: TurnSnapshot | null | undefined,
  next: TurnSnapshot,
): boolean {
  return (
    previous != null &&
    isRuntimeHostTerminalTurn(previous) &&
    isRuntimeHostTerminalTurn(next) &&
    previous.runId === next.runId &&
    previous.terminalEventId === next.terminalEventId
  );
}

function liveProviderRetryEvent(
  previous: TurnSnapshot | null | undefined,
  next: TurnSnapshot | null | undefined,
  ts: number,
): Extract<SessionEvent, { type: 'provider_retry' }> | undefined {
  if (!next || isRuntimeHostTerminalTurn(next) || !next.providerRetry) return undefined;
  const previousRetry =
    previous && !isRuntimeHostTerminalTurn(previous) ? previous.providerRetry : undefined;
  if (previous?.runId === next.runId && isDeepStrictEqual(previousRetry, next.providerRetry)) {
    return undefined;
  }
  return providerRetryEvent(next, ts);
}

function providerRetryEvent(
  root: LiveTurnSnapshot,
  ts: number,
): Extract<SessionEvent, { type: 'provider_retry' }> {
  const retry = root.providerRetry;
  if (!retry) {
    throw new Error('Non-terminal Turn snapshot has no provider retry');
  }
  if (retry.phase !== 'scheduled') {
    return {
      type: 'provider_retry',
      id: `host-seed:${root.runId}:provider_retry`,
      turnId: root.turnId,
      ts,
      phase: 'started',
      attempt: retry.attempt,
      maxAttempts: retry.maxAttempts,
      reason: retry.reason,
    };
  }
  // remainingMs is the skew-free countdown authority for clients on another
  // machine: a duration, recomputed from the host-clock schedule time stored
  // in the snapshot, so a mid-wait re-projection (reconnect) does not restart
  // the countdown. Snapshots from older runtimes lack `ts` and degrade to the
  // full delay.
  const remainingMs =
    retry.ts === undefined ? retry.delayMs : Math.max(0, retry.delayMs - (ts - retry.ts));
  return {
    type: 'provider_retry',
    id: `host-seed:${root.runId}:provider_retry`,
    turnId: root.turnId,
    ts,
    phase: 'scheduled',
    attempt: retry.attempt,
    maxAttempts: retry.maxAttempts,
    delayMs: retry.delayMs,
    remainingMs,
    reason: retry.reason,
  };
}

function abortReason(source: string): Extract<SessionEvent, { type: 'abort' }>['reason'] {
  if (source.includes('timeout')) return 'timeout';
  if (source.includes('crash') || source.includes('restart')) return 'crash';
  if (source.includes('redirect')) return 'redirect';
  return 'user_stop';
}
