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

import type { RuntimeContinuationMetadata } from '@maka/core/backend-types';
import type { RuntimeEvent } from '@maka/core/runtime-event';
import type { RuntimeInvocationRecord } from '@maka/core/runtime-invocation';

/** A task starts at a user message; steering only amends the existing task. */
function isTaskOpeningMessage(event: RuntimeEvent): boolean {
  return event.role === 'user' && event.content?.kind === 'text' && event.content.steering !== true;
}

/**
 * A mid-task checkpoint must preserve the latest task's original user message.
 * Continuations can extend its coverage into new turns without adding a user
 * message. A newer task opening (including a Host-originated one) invalidates
 * an older anchor; a steering message must never become the anchor.
 */
export function matchesHistoryCompactHeadAnchor(
  events: readonly RuntimeEvent[],
  reference: { runtimeEventId: string; turnId: string },
): boolean {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (!isTaskOpeningMessage(event)) continue;
    return (
      event.id === reference.runtimeEventId &&
      event.turnId === reference.turnId &&
      (event.author === 'user' || event.author === 'host') &&
      event.partial !== true &&
      event.modelVisibility !== 'hidden'
    );
  }
  return false;
}

/**
 * Follow continuation and handoff edges to the task's fresh invocation.
 * Only its durable opening user event is eligible: missing/cyclic ancestry
 * must not borrow a prompt from an unrelated task in the session history.
 */
export function resolveContinuationHeadAnchor(input: {
  sessionId: string;
  continuation: RuntimeContinuationMetadata;
  runtimeContext: readonly RuntimeEvent[];
  invocations: readonly RuntimeInvocationRecord[];
}): RuntimeEvent | undefined {
  const byId = new Map(
    input.invocations.map((invocation) => [invocation.invocationId, invocation]),
  );
  const visited = new Set<string>();
  let source = input.continuation;
  for (;;) {
    if (visited.has(source.sourceInvocationId)) return undefined;
    visited.add(source.sourceInvocationId);
    const invocation = byId.get(source.sourceInvocationId);
    if (
      !invocation ||
      invocation.sessionId !== input.sessionId ||
      invocation.runId !== source.sourceRunId ||
      invocation.turnId !== source.sourceTurnId
    ) {
      return undefined;
    }
    if (invocation.opening.source.kind !== 'fresh') {
      source = invocation.opening.source;
      continue;
    }
    const anchor = input.runtimeContext.find(
      (event) =>
        event.sessionId === input.sessionId &&
        event.invocationId === invocation.invocationId &&
        event.runId === invocation.runId &&
        event.turnId === invocation.turnId &&
        isTaskOpeningMessage(event),
    );
    return anchor &&
      matchesHistoryCompactHeadAnchor(input.runtimeContext, {
        runtimeEventId: anchor.id,
        turnId: anchor.turnId,
      })
      ? anchor
      : undefined;
  }
}
