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

import { requireCount, requireId, requireShapedRecord, requireUtf8String } from './codec.js';
import { invalidProtocolFrame } from './errors.js';

export const SESSION_ATTENTION_BODY_MAX_BYTES = 2_048;

export interface SessionAttention {
  readonly kind: 'completed' | 'errored' | 'waiting';
  readonly eventId: string;
  readonly body?: string;
}

export interface SessionCatalogChangedFrame {
  readonly kind: 'session.catalog.changed';
  readonly revision: number;
  readonly sessionId: string;
  readonly attention?: SessionAttention;
}

function decodeSessionAttention(value: unknown): SessionAttention {
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

export function decodeSessionCatalogChangedFrame(value: unknown): SessionCatalogChangedFrame {
  const frame = requireShapedRecord(
    value,
    'Session catalog changed frame',
    ['kind', 'revision', 'sessionId'],
    ['attention'],
  );
  return {
    kind: 'session.catalog.changed',
    revision: requireCount(frame.revision, 'Session catalog change revision'),
    sessionId: requireId(frame.sessionId, 'sessionId'),
    ...(frame.attention === undefined
      ? {}
      : { attention: decodeSessionAttention(frame.attention) }),
  };
}
