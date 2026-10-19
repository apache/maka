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
import { defineOperation } from './operation-spec.js';
import { requireEncodedByteLimit } from './codec.js';
export const REMOTE_TOOLS_RESULT_BYTES = 2 * 1024 * 1024;
const id = z.string().min(1).max(256);
const origin = z.object({ hostId: id, sessionId: id }).strict();
export const remoteToolsRequest = z.discriminatedUnion('action', [
  z.object({ action: z.literal('origin'), sessionId: id }).strict(),
  z.object({ action: z.literal('contexts') }).strict(),
  z
    .object({ action: z.literal('open'), originHost: id, originSession: id, templateSession: id })
    .strict(),
  z
    .object({
      action: z.literal('search'),
      contextId: id,
      origin,
      query: z.string().max(300).default(''),
    })
    .strict(),
  z
    .object({
      action: z.literal('call'),
      contextId: id,
      origin,
      callId: id,
      tool: id,
      arguments: z.unknown(),
    })
    .strict(),
  z.object({ action: z.literal('cancel'), contextId: id, origin, callId: id }).strict(),
  z.object({ action: z.literal('result'), contextId: id, origin, callId: id }).strict(),
  z.object({ action: z.literal('events'), originHost: id }).strict(),
  z.object({ action: z.literal('ack'), ids: z.array(id).max(100) }).strict(),
  z
    .object({ action: z.literal('deliver'), sessionId: id, id, source: id, content: z.unknown() })
    .strict(),
]);
export type RemoteToolsRequest = z.infer<typeof remoteToolsRequest>;
export const REMOTE_TOOLS_OPERATION_SPECS = {
  'remote.tools': defineOperation<
    RemoteToolsRequest,
    { value: unknown },
    | 'invalid_request'
    | 'unauthorized'
    | 'host_not_ready'
    | 'host_draining'
    | 'operation_unavailable'
    | 'internal_failure'
  >({
    mode: 'command',
    availability: 'ready',
    errors: [
      'invalid_request',
      'unauthorized',
      'host_not_ready',
      'host_draining',
      'operation_unavailable',
      'internal_failure',
    ],
    decodeInput(value) {
      requireEncodedByteLimit(value, 'Remote tool request', 128 * 1024);
      return remoteToolsRequest.parse(value);
    },
    decodeOutput(value) {
      requireEncodedByteLimit(value, 'Remote tool result', REMOTE_TOOLS_RESULT_BYTES);
      return z.object({ value: z.unknown() }).strict().parse(value);
    },
  }),
};
