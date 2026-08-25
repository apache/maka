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
import { SESSION_MAILBOX_TEXT_MAX_BYTES } from '@maka/core/session-mailbox';
import type { MakaTool } from './tool-runtime.js';

export const SESSION_LIST_TOOL_NAME = 'session_list';
export const SESSION_SEND_TOOL_NAME = 'session_send';
export const SESSION_REPLY_TOOL_NAME = 'session_reply';

export interface SessionMailboxToolTarget {
  readonly sessionId: string;
  readonly name: string;
  readonly status: 'idle' | 'running' | 'waiting_for_user';
}

export interface SessionMailboxToolSendResult {
  readonly messageId: string;
  readonly targetSessionId: string;
  readonly disposition: 'turn_started' | 'queued';
  readonly turnId?: string;
}

export interface SessionMailboxToolAuthority {
  list(sourceSessionId: string): Promise<readonly SessionMailboxToolTarget[]>;
  send(input: {
    sourceSessionId: string;
    targetSessionId: string;
    kind: 'request' | 'reply' | 'notification';
    text: string;
    correlationId?: string;
  }): Promise<SessionMailboxToolSendResult>;
}

const targetSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/)
  .describe(`Target Session id returned by ${SESSION_LIST_TOOL_NAME}.`);
const textSchema = z
  .string()
  .trim()
  .min(1)
  .refine((value) => new TextEncoder().encode(value).byteLength <= SESSION_MAILBOX_TEXT_MAX_BYTES, {
    message: `Session message exceeds ${SESSION_MAILBOX_TEXT_MAX_BYTES} UTF-8 bytes`,
  });

export function buildSessionMailboxTools(authority: SessionMailboxToolAuthority): MakaTool[] {
  return [
    {
      name: SESSION_LIST_TOOL_NAME,
      displayName: 'Session List',
      description: 'List other user Sessions in the same project that this Session may contact.',
      parameters: z.object({}),
      impl: async (_input, ctx) => {
        const targets = await authority.list(ctx.sessionId);
        return targets.length === 0
          ? 'No reachable Sessions.'
          : targets
              .map((target) => `- ${target.sessionId} | ${target.name} | ${target.status}`)
              .join('\n');
      },
    },
    {
      name: SESSION_SEND_TOOL_NAME,
      displayName: 'Session Send',
      description:
        'Send a durable message to another Session in the same project. Requests ask the target ' +
        `to process the message and reply with ${SESSION_REPLY_TOOL_NAME}; notifications do not require a reply.`,
      parameters: z.object({
        target_session_id: targetSchema,
        text: textSchema,
        kind: z.enum(['request', 'notification']).default('request'),
      }),
      impl: async (input, ctx) =>
        formatDelivery(
          await authority.send({
            sourceSessionId: ctx.sessionId,
            targetSessionId: input.target_session_id,
            kind: input.kind,
            text: input.text,
          }),
        ),
    },
    {
      name: SESSION_REPLY_TOOL_NAME,
      displayName: 'Session Reply',
      description: 'Reply to a Session request using its source Session and message identities.',
      parameters: z.object({
        target_session_id: targetSchema,
        in_reply_to: z
          .string()
          .min(1)
          .max(128)
          .regex(/^[A-Za-z0-9_-]+$/),
        text: textSchema,
      }),
      impl: async (input, ctx) =>
        formatDelivery(
          await authority.send({
            sourceSessionId: ctx.sessionId,
            targetSessionId: input.target_session_id,
            kind: 'reply',
            text: input.text,
            correlationId: input.in_reply_to,
          }),
        ),
    },
  ];
}

function formatDelivery(result: SessionMailboxToolSendResult): string {
  return [
    `Session message ${result.messageId} ${result.disposition === 'queued' ? 'queued' : 'delivered'}.`,
    `target=${result.targetSessionId}`,
    ...(result.turnId ? [`turn=${result.turnId}`] : []),
  ].join('\n');
}
