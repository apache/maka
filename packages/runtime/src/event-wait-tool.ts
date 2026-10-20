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
import type { MakaTool, MakaToolContext } from './tool-runtime.js';

export interface EventWaitRequest {
  resource: EventWaitRecord['resource'];
  condition: EventWaitRecord['condition'];
  reason: string;
  timeoutMs: number;
}
export const EVENT_WAIT_TOOL_NAME = 'WaitForEvent';
const receipts = new WeakSet<object>();
export interface EventWaitYieldReceipt {
  readonly kind: 'event_wait_registered';
  readonly waitId: string;
  readonly deadlineAt: number;
}
/** Only the internal tool can produce a live yield capability. Persisted JSON is not authority. */
export function isEventWaitYieldReceipt(value: unknown): value is EventWaitYieldReceipt {
  return typeof value === 'object' && value !== null && receipts.has(value);
}
/** Internal composition seam. Never added to the production builtin tool catalog. */
export function buildEventWaitTool(
  register: (
    input: EventWaitRequest,
    context: MakaToolContext,
  ) => Promise<{ waitId: string; deadlineAt: number }>,
): MakaTool {
  return {
    name: EVENT_WAIT_TOOL_NAME,
    description:
      'Register a supported condition on an authorized resource and end this Turn. Host continues the Goal once a result or timeout is available.',
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
        timeoutMs: z
          .number()
          .int()
          .positive()
          .max(7 * 24 * 60 * 60_000),
      })
      .strict(),
    executionSemantics: 'exclusive_step',
    nesting: 'direct_only',
    recoveryMode: 'never_auto_retry',
    impl: async (input, context) => {
      const result = await register(input as EventWaitRequest, context);
      const receipt: EventWaitYieldReceipt = Object.freeze({
        kind: 'event_wait_registered',
        ...result,
      });
      receipts.add(receipt);
      return receipt;
    },
  };
}
