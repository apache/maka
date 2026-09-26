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

import { requireExactRecord, requireId, requireShapedRecord, requireUtf8String } from './codec.js';
import { invalidProtocolFrame } from './errors.js';
import { defineOperation } from './operation-spec.js';

export const SESSION_ATTENTION_BODY_MAX_BYTES = 2_048;

export interface SessionAttention {
  readonly kind: 'completed' | 'errored' | 'waiting';
  readonly eventId: string;
  readonly body?: string;
}

export interface SessionAttentionSubscribeResult {
  readonly subscribed: true;
}

export const SESSION_ATTENTION_OPERATION_SPECS = {
  'session.attention.subscribe': defineOperation({
    mode: 'control',
    availability: 'ready',
    errors: [
      'host_not_ready',
      'host_draining',
      'operation_unavailable',
      'internal_failure',
    ] as const,
    decodeInput: (value: unknown): Record<string, never> => {
      requireExactRecord(value, 'Session attention subscribe input', []);
      return {};
    },
    decodeOutput: (value: unknown): SessionAttentionSubscribeResult => {
      const result = requireExactRecord(value, 'Session attention subscribe result', [
        'subscribed',
      ]);
      if (result.subscribed !== true) {
        throw invalidProtocolFrame('Invalid Session attention subscription result');
      }
      return { subscribed: true };
    },
  }),
} as const;

export function decodeSessionAttention(value: unknown): SessionAttention {
  const attention = requireShapedRecord(value, 'Session attention', ['kind', 'eventId'], ['body']);
  if (
    attention.kind !== 'completed' &&
    attention.kind !== 'errored' &&
    attention.kind !== 'waiting'
  ) {
    throw invalidProtocolFrame('Invalid Session attention kind');
  }
  return {
    kind: attention.kind,
    eventId: requireId(attention.eventId, 'Session attention eventId'),
    ...(attention.body === undefined
      ? {}
      : {
          body: requireUtf8String(
            attention.body,
            'Session attention body',
            SESSION_ATTENTION_BODY_MAX_BYTES,
          ),
        }),
  };
}
