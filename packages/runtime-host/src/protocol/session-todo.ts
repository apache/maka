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

import { normalizeSessionTodoItems, type SessionTodoSnapshot } from '@maka/core/session-todo';
import { requireEntityId, requireExactRecord } from './codec.js';
import { invalidProtocolFrame } from './errors.js';
import { defineOperation } from './operation-spec.js';

const QUERY_ERRORS = [
  'host_not_ready',
  'host_draining',
  'operation_unavailable',
  'invalid_request',
  'not_found',
  'internal_failure',
] as const;

export interface SessionTodoQueryInput {
  readonly sessionId: string;
}

export interface SessionTodoQueryResult extends SessionTodoSnapshot {
  readonly sessionId: string;
}

export const SESSION_TODO_OPERATION_SPECS = {
  'session.todo.query': defineOperation<
    SessionTodoQueryInput,
    SessionTodoQueryResult,
    (typeof QUERY_ERRORS)[number]
  >({
    mode: 'query',
    availability: 'ready',
    errors: QUERY_ERRORS,
    decodeInput: decodeSessionTodoQueryInput,
    decodeOutput: decodeSessionTodoQueryResult,
  }),
} as const;

export function decodeSessionTodoQueryInput(value: unknown): SessionTodoQueryInput {
  const input = requireExactRecord(value, 'SessionTodo query input', ['sessionId']);
  return { sessionId: requireEntityId(input.sessionId, 'sessionId') };
}

export function decodeSessionTodoQueryResult(value: unknown): SessionTodoQueryResult {
  const result = requireExactRecord(value, 'SessionTodo query result', ['sessionId', 'items']);
  const normalized = normalizeSessionTodoItems(result.items);
  if (!normalized.ok)
    throw invalidProtocolFrame(`Invalid SessionTodo result: ${normalized.message}`);
  return {
    sessionId: requireEntityId(result.sessionId, 'sessionId'),
    items: normalized.value.items,
  };
}
