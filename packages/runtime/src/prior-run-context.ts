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

import type { RuntimeEvent } from '@maka/core/runtime-event';
import type { RuntimeEventStore } from '@maka/core/runtime-event-store';
import { isSessionInlineInvocation } from '@maka/core/runtime-invocation';
import type { RuntimeInvocationRecord } from '@maka/core/runtime-invocation';
import { buildRuntimeEventModelReplayPlan } from './model-history.js';

export interface PriorRuntimeContext {
  events: RuntimeEvent[];
  invocations: RuntimeInvocationRecord[];
}

export interface BuildPriorRuntimeContextInput {
  sessionId: string;
  currentRunId: string;
  currentTurnId: string;
  runtimeEventStore?: RuntimeEventStore;
  runtimeEventStoreAvailable: boolean;
}

/**
 * The conversation the model must see before this turn: every earlier
 * session-inline invocation's events, in the order the Session committed them.
 *
 * A prior invocation that never reached a terminal event is still replayed. It
 * was stopped while parked on an interaction, or the process died mid-turn, and
 * its turn — the user's message included — is conversation either way. There is
 * nothing left to reconcile here: the events are the run, so an invocation
 * cannot claim an outcome its ledger does not show.
 */
export async function buildPriorRuntimeContext(
  input: BuildPriorRuntimeContextInput,
): Promise<PriorRuntimeContext | undefined> {
  const store = input.runtimeEventStore;
  if (!store || !input.runtimeEventStoreAvailable) return undefined;

  const invocations = (await store.listSessionInvocations(input.sessionId)).filter(
    (invocation) =>
      invocation.runId !== input.currentRunId &&
      invocation.turnId !== input.currentTurnId &&
      isSessionInlineInvocation(invocation.opening),
  );
  if (invocations.length === 0) return undefined;

  const events: RuntimeEvent[] = [];
  for (const invocation of invocations) {
    const committed = await store.readRuntimeEvents(input.sessionId, invocation.runId);
    for (const event of committed) {
      if (event.runId !== input.currentRunId && event.turnId !== input.currentTurnId) {
        events.push(event);
      }
    }
  }
  if (events.length === 0 || buildRuntimeEventModelReplayPlan(events).items.length === 0)
    return undefined;
  return { events, invocations };
}
