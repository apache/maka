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

import { z } from 'zod';
import type { EventWaitRecord } from '@maka/core/event-wait';
import type { MakaTool, MakaToolContext, MakaToolDurableOutcome } from './tool-runtime.js';

/** Bounded result returned by the ordinary WaitForEvent tool. */
export interface EventWaitToolResult {
  readonly kind: 'event_wait_result';
  readonly waitId: string;
  readonly outcome:
    | 'satisfied'
    | 'expired'
    | 'invalidated'
    | 'source_unavailable'
    | 'cancelled'
    | 'interrupted';
  readonly observedAt: number;
  readonly deadlineAt: number | null;
  readonly evidenceRefs: readonly string[];
  readonly reason?: string;
}

export interface EventWaitRequest {
  resource: EventWaitRecord['resource'];
  condition: EventWaitRecord['condition'];
  reason: string;
  timeoutMs?: number;
  /** Resume this exact interrupted wait without resetting its absolute deadline. */
  resumeWaitId?: string;
}
export const EVENT_WAIT_TOOL_NAME = 'WaitForEvent';
const steeringInterruptions = new WeakSet<object>();
/** A Host tool result can request a Code Mode boundary; serialized JSON cannot. */
export function isEventWaitSteeringInterruption(value: unknown): value is EventWaitToolResult {
  return typeof value === 'object' && value !== null && steeringInterruptions.has(value);
}

/** An ordinary asynchronous tool: observation returns to this exact invocation. */
export function buildEventWaitTool(
  awaitCondition: (
    input: EventWaitRequest,
    context: MakaToolContext,
  ) => Promise<EventWaitToolResult>,
  acknowledge?: (outcome: MakaToolDurableOutcome) => void | Promise<void>,
): MakaTool {
  return {
    name: EVENT_WAIT_TOOL_NAME,
    description:
      'Wait for an observable external condition without ending this Turn. The Host observes the source and returns one result to this tool call; continue working after it returns. Use a supported resource and versioned condition. For supported conditions, call this tool when the condition is known instead of repeatedly reading status or sleeping. For a background Bash task use resource {providerId: "shell_run", connectionId: null, resourceType: "background_task", resourceId: the canonical maka://runtime/background-tasks/... ref} and condition {typeId: "terminal", version: 1, parameters: {}}. Optional timeoutMs limits this wait; omitting it adds no deadline beyond the current execution. Terminal does not mean success: inspect the result with Read. Cancelling or expiring the wait does not stop the background task. User input may interrupt the wait so the same Turn can process it. To resume an interrupted wait, pass its returned waitId as resumeWaitId and the same resource and condition; this retains the original absolute deadline.',
    parameters: z
      .object({
        resource: z
          .object({
            providerId: z.string(),
            connectionId: z.string().nullable(),
            resourceType: z.string(),
            resourceId: z.string(),
          })
          .strict(),
        condition: z
          .object({
            typeId: z.string(),
            version: z.number().int().positive(),
            parameters: z.record(z.string(), z.unknown()),
          })
          .strict(),
        reason: z.string().min(1).max(500),
        timeoutMs: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
        resumeWaitId: z.string().min(1).max(128).optional(),
      })
      .strict(),
    recoveryMode: 'never_auto_retry',
    ...(acknowledge ? { onDurableOutcomeCommitted: acknowledge } : {}),
    impl: async (input, context) => {
      const result = await awaitCondition(input as EventWaitRequest, context);
      if (result.outcome === 'interrupted' && result.reason === 'user_input')
        steeringInterruptions.add(result);
      return result;
    },
  };
}
