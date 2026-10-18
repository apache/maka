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
const request = z
  .object({
    method: z.enum([
      'assistant.enablement',
      'assistant.set-enabled',
      'assistant.binding',
      'assistant.original',
      'assistant.status',
      'assistant.bind',
      'assistant.control',
      'assistant.recover',
      'assistant.adopt-task',
    ]),
    input: z.unknown(),
  })
  .strict();
export type PersonalAssistantRequest = z.infer<typeof request>;
export const PERSONAL_ASSISTANT_OPERATION_SPECS = {
  'personal-assistant.call': defineOperation<
    PersonalAssistantRequest,
    { value: unknown },
    | 'host_not_ready'
    | 'host_draining'
    | 'operation_unavailable'
    | 'invalid_request'
    | 'internal_failure'
  >({
    mode: 'command',
    availability: 'ready',
    errors: [
      'host_not_ready',
      'host_draining',
      'operation_unavailable',
      'invalid_request',
      'internal_failure',
    ],
    decodeInput(value) {
      requireEncodedByteLimit(value, 'Personal assistant request', 32 * 1024);
      return request.parse(value);
    },
    decodeOutput(value) {
      requireEncodedByteLimit(value, 'Personal assistant response', 480 * 1024);
      return z.object({ value: z.unknown() }).strict().parse(value);
    },
  }),
} as const;
