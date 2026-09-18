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

import { join } from 'node:path';
import { WORKHUB_COORDINATION_SESSION_ID } from '@maka/core/session';
import type { MakaTool, MakaToolContext } from '@maka/runtime/tool-runtime';
import { z } from 'zod';
import { VOICE_QUEUE_FILENAME, WorkHubVoiceStateStore } from './workhub-voice-state.js';

export const WORKHUB_VOICE_QUEUE_TOOL_NAMES = [
  'voice_reply',
  'voice_log_read',
  'voice_queue_read',
  'voice_queue_update',
] as const;
function store(context: MakaToolContext): WorkHubVoiceStateStore {
  if (context.sessionId !== WORKHUB_COORDINATION_SESSION_ID)
    throw new Error('Voice queue tools are only available in the WorkHub coordination session');
  context.abortSignal.throwIfAborted();
  return new WorkHubVoiceStateStore(join(context.cwd, VOICE_QUEUE_FILENAME));
}
export function createWorkHubVoiceQueueTools(): readonly MakaTool[] {
  const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
  const reply = z
    .object({
      id,
      requestId: id.describe('Original voice request ID provided with the delegated input.'),
      text: z.string().min(1).max(32000),
      kind: z.enum(['answer', 'update', 'question', 'failure']).default('answer'),
    })
    .strict();
  const page = z
    .object({
      itemId: z.string().optional(),
      offset: z.number().int().min(0).optional(),
      limit: z.number().int().min(1).max(16).optional(),
    })
    .strict();
  const archive = z
    .object({
      view: z
        .enum(['turns', 'events'])
        .optional()
        .describe(
          'Default: turns, one user or assistant native turn per record. Choose events to inspect interruptions, delegation, task results or delivery facts. Supplying kind also selects events.',
        ),
      callId: z
        .string()
        .optional()
        .describe(
          'Exact voice call ID. Use the callId supplied with the voice maintenance to avoid mixing calls.',
        ),
      kind: z
        .string()
        .optional()
        .describe(
          'Exact event kind, for example transcript, transcript_delta, delegation, task_result, reply_prepared or delivery_sent. Supplying kind selects event records instead of conversation turns.',
        ),
      query: z
        .string()
        .optional()
        .describe(
          'Literal substring in event data, not a regular expression. Omit to read the whole selected range.',
        ),
      relatedId: z
        .string()
        .optional()
        .describe(
          'In turns view: match a native turn ID. In events view: find an ID appearing in event data. Combined with other filters using AND.',
        ),
      after: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe(
          'Exclusive log sequence cursor, not a timestamp or row offset. Start with the review after value; for the next record page use returned nextAfter.',
        ),
      before: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe(
          'Inclusive event timestamp ceiling in Unix milliseconds. For a log sequence ceiling use snapshot instead.',
        ),
      snapshot: z
        .number()
        .int()
        .min(0)
        .max(Number.MAX_SAFE_INTEGER)
        .optional()
        .describe(
          'Inclusive log sequence ceiling. Omit on the first read to freeze the current log for this WorkHub turn. Reuse the returned snapshot across queries and pages; later records stay hidden until a new turn. An explicit value can narrow but cannot widen this turn’s ceiling.',
        ),
      limit: z
        .number()
        .int()
        .min(1)
        .max(64)
        .optional()
        .describe(
          'How many complete turns to return: 1–64, default 6. A user turn and an assistant turn count separately. In events view this counts events (default 16). Text is never split across pages.',
        ),
    })
    .strict();
  const receipt = (state: import('../protocol/workhub-voice-state.js').WorkHubVoiceState) => ({
    queue: state.queue.slice(0, 16).map(({ id }) => ({ id })),
    queueTotal: state.queue.length,
    ...(state.queue.length > 16 ? { nextQueueOffset: 16 } : {}),
    blocked: state.deliveries
      .filter((d) => d.status === 'reserved' || d.status === 'uncertain')
      .map(({ id, deliveryId, status }) => ({ id, deliveryId, status })),
  });
  const update = z
    .object({
      resolveDeliveries: z
        .array(z.string())
        .optional()
        .describe(
          'Resolve uncertain delivery IDs after reviewing the evidence. This releases the transport fence without replaying the old item or claiming it was heard. Arrange any further communication in the list.',
        ),
      order: z
        .array(id)
        .max(256)
        .optional()
        .describe(
          'Item IDs in priority order. Consumed IDs are automatically ignored. Unmentioned current items stay after these, in their existing order.',
        ),
      upsert: z
        .array(
          z
            .object({
              id,
              text: z
                .string()
                .min(1)
                .max(32000)
                .describe(
                  'What this communication should accomplish and the background or material voice needs to express it naturally.',
                ),
            })
            .strict(),
        )
        .max(256)
        .optional()
        .describe(
          'Add or revise pending communication. Use stable IDs and include only the intent and necessary expression material; text is sent to voice.',
        ),
      remove: z
        .array(id)
        .max(256)
        .optional()
        .describe(
          'Explicitly cancel obsolete items by ID. Consumption is handled automatically; never remove items just to acknowledge delivery.',
        ),
    })
    .strict();
  return [
    {
      name: 'voice_reply',
      presentation: 'internal',
      activityKind: 'edit',
      categoryHint: 'custom_tool',
      recoveryMode: 'never_auto_retry',
      description:
        'Return a result or question to its original voice delegation by requestId. Use a stable id for this reply. This is the native correlated return channel, independent of the supplemental list. Repeating the same id and content is idempotent. Admission does not prove the user heard it.',
      parameters: reply,
      impl: async (input, context) => {
        const output = reply.parse(input);
        await store(context).enqueue(output);
        return { id: output.id, requestId: output.requestId, status: 'accepted' };
      },
    },
    {
      name: 'voice_log_read',
      presentation: 'internal',
      activityKind: 'read',
      categoryHint: 'read',
      description:
        'Read voice history from SQLite. By default return a page of native user/assistant turns with full text, role, turnId and status. In-progress turns contain text assembled through the snapshot; completed turns contain their final transcript. limit counts turns, not characters. Use nextAfter and the same snapshot for the next page. Set view=events or kind to query interaction events instead. No JSON string slicing. Transcripts do not prove every word was heard.',
      parameters: archive,
      impl: async (input, context) => {
        const { view, ...query } = archive.parse(input);
        const turns = view !== 'events' && query.kind === undefined;
        const result = await store(context).log({ ...query, turns }, context.turnId);
        if (!turns) return result;
        return {
          snapshot: result.snapshot,
          turns: result.entries.map((entry) => {
            const data = entry.data as {
              nativeTurnId: string;
              role: string;
              text: string;
              final: boolean;
              start_ms?: number;
              end_ms?: number;
            };
            return {
              sequence: entry.sequence,
              callId: entry.callId,
              turnId: data.nativeTurnId,
              role: data.role,
              text: data.text,
              status: data.final ? 'done' : 'in_progress',
              ...(data.start_ms === undefined ? {} : { start_ms: data.start_ms }),
              ...(data.end_ms === undefined ? {} : { end_ms: data.end_ms }),
            };
          }),
          ...(result.nextAfter === undefined ? {} : { nextAfter: result.nextAfter }),
        };
      },
    },
    {
      name: 'voice_queue_read',
      presentation: 'internal',
      activityKind: 'read',
      categoryHint: 'read',
      description:
        'Read current supplemental speech in priority order. Normal request replies use a separate channel. Set itemId to read full content; otherwise returns previews with offset/limit. Use voice_log_read for past interactions and sends. This is a pending speech list, not all unfinished work.',
      parameters: page,
      impl: async (input, context) => {
        return store(context).current(page.parse(input));
      },
    },
    {
      name: 'voice_queue_update',
      presentation: 'internal',
      activityKind: 'edit',
      categoryHint: 'custom_tool',
      recoveryMode: 'never_auto_retry',
      description:
        'Maintain the ordered list of prepared communication. Jev checks it after dialogue or list changes; only approved content is sent when voice is idle. Normal delegated task replies use voice_reply. Updates merge atomically; consumed/reserved IDs are filtered and unseen additions preserved. Reserved items belong to the outlet. If still needed, correcting sent content requires a new item. New events do not block list edits.',
      parameters: update,
      impl: async (input, context) => {
        const change = update.parse(input);
        const result = await store(context).update({
          ...change,
          upsert: change.upsert?.map((item) => ({ ...item, context: '' })),
        });
        return receipt(result);
      },
    },
  ];
}
