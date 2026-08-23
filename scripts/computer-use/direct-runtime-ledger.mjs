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

import {
  createSessionEventMapMemory,
  mapSessionEventToRuntimeEvent,
} from '../../packages/runtime/dist/ai-sdk-flow.js';

export function createDirectRuntimeTurnLedger({ sessionId, turnId, text, newId, now }) {
  const invocationId = `${sessionId}-invocation`;
  const runId = `${sessionId}-run`;
  const anchor = {
    id: newId(),
    invocationId,
    runId,
    sessionId,
    turnId,
    ts: now(),
    partial: false,
    role: 'user',
    author: 'user',
    content: { kind: 'text', text },
  };
  const events = [anchor];
  const memory = createSessionEventMapMemory();
  const context = {
    sessionId,
    invocationId,
    runId,
    turnId,
    source: 'desktop',
    startedAt: anchor.ts,
    request: {
      sessionId,
      turnId,
      text,
      source: 'desktop',
      initialRuntimeEvent: anchor,
    },
    newId,
    now,
  };

  return {
    anchor,
    loadTurnRuntimeEvents: async (requestedTurnId) =>
      events.filter((event) => event.turnId === requestedTurnId),
    record(sessionEvent) {
      const event = mapSessionEventToRuntimeEvent(sessionEvent, context, memory);
      if (event.partial !== true && event.content?.kind !== 'error') events.push(event);
    },
  };
}
