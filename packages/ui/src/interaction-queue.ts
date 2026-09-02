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

import type { ActiveInteractionRequestEvent, SessionEvent } from '@maka/core/events';

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

export function reduceInteractionQueues(
  queues: InteractionQueues,
  sessionId: string,
  event: SessionEvent,
): InteractionQueues {
  switch (event.type) {
    case 'sandbox_boundary_request':
    case 'client_capability_request':
    case 'user_question_request':
      return enqueueInteraction(queues, sessionId, event);
    case 'sandbox_boundary_decision_ack':
    case 'client_capability_decision_ack':
    case 'user_question_answer_ack':
      return dequeueInteractionByRequestId(queues, sessionId, event.requestId);
    case 'tool_result':
      return dequeueInteractionByToolUseId(queues, sessionId, event.toolUseId);
    case 'error':
      return clearInteractions(queues, sessionId);
    default:
      return queues;
  }
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
