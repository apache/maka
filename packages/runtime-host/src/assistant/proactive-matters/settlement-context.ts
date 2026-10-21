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

import { readLogicalRuntimeExecutionForRun } from '@maka/core/runtime-logical-execution';
import { readRunInvocation, type RuntimeEventStore } from '@maka/core/runtime-event-store';
import { createHash } from 'node:crypto';
import type { MatterSnapshot } from './matter.js';
import type { RuntimeEvent } from '@maka/core/runtime-event';
import type { MakaToolContext } from './host-types.js';

export function matterInput(snapshot: MatterSnapshot) {
  const m = snapshot.matter;
  return {
    matterId: m.id,
    activationId: m.activation!.id,
    request: m.request,
    note: m.stateText,
    eventCursor: snapshot.events.at(-1)?.sequence ?? m.activation!.eventCursor,
    events: snapshot.events,
    pendingEventCount: snapshot.pendingEventCount,
  };
}
function inputBasis(value: ReturnType<typeof matterInput>): string {
  const { matterId, activationId, request, note, eventCursor, events, pendingEventCount } = value;
  return createHash('sha256')
    .update(
      JSON.stringify({
        matterId,
        activationId,
        request,
        note,
        eventCursor,
        events,
        pendingEventCount,
      }),
    )
    .digest('hex');
}
export function matterInputBasis(snapshot: MatterSnapshot): string {
  return inputBasis(matterInput(snapshot));
}

export function deliveredMatterInput(events: readonly RuntimeEvent[], call: MakaToolContext) {
  let delivered: string | undefined;
  for (const event of events) {
    if (event.sessionId !== call.sessionId || event.turnId !== call.turnId || event.partial)
      continue;
    const content = event.content;
    if (!content) continue;
    if (
      content.kind === 'function_call' &&
      content.id === call.toolCallId &&
      (call.runId === undefined || event.runId === call.runId)
    ) {
      if (!delivered) return undefined;
      try {
        // Runtime may prepend its metadata wrapper before the task's own header.
        const start = delivered.indexOf('\n{');
        if (start < 0) return undefined;
        const value = JSON.parse(delivered.slice(start + 1));
        if (
          typeof value.activationId !== 'string' ||
          typeof value.request !== 'string' ||
          typeof value.note !== 'string' ||
          !Array.isArray(value.events) ||
          !Number.isSafeInteger(value.eventCursor)
        )
          return undefined;
        return {
          activationId: value.activationId as string,
          basis: inputBasis(value),
          eventCursor: value.eventCursor as number,
        };
      } catch {
        return undefined;
      }
    }
    if (
      event.role === 'system' &&
      event.author === 'host' &&
      content.kind === 'text' &&
      content.runtimeContextName === 'proactive-matters.inbox'
    )
      delivered = content.text;
  }
  return undefined;
}

/** Only the worker's own lifecycle tools, alongside ordinary business tools. */
export const MATTER_WORKER_TOOLS = new Set([
  'MatterRead',
  'MatterReadFile',
  'MatterWriteFile',
  'MatterCheckpoint',
  'MatterSettle',
  'MatterConditionTest',
  'MatterAskBot',
]);
export function workerTools<T extends { name: string }>(tools: readonly T[]): T[] {
  return tools.filter(
    (tool) => !tool.name.startsWith('Matter') || MATTER_WORKER_TOOLS.has(tool.name),
  );
}

/** Read only the authenticated handoff lineage, in replay order. */
export async function readMatterRuntimeEvents(
  store: Parameters<typeof readLogicalRuntimeExecutionForRun>[0] &
    Pick<RuntimeEventStore, 'readRuntimeEvents'>,
  sessionId: string,
  runId: string,
): Promise<readonly RuntimeEvent[]> {
  const run = await readRunInvocation(store, sessionId, runId);
  if (!run) return [];
  if (run.opening.source.kind !== 'handoff') return store.readRuntimeEvents(sessionId, runId);
  const logical = await readLogicalRuntimeExecutionForRun(store, {
    sessionId,
    runId,
    turnId: run.turnId,
  });
  if (!logical) return [];
  // The core reader verifies seals, claims and successor openings. Do not
  // include unrelated session history or later successors of this caller.
  const precedingRuns = logical.runIds.slice(0, logical.runIds.indexOf(runId));
  const inherited = await Promise.all(
    precedingRuns.map((id) => store.readImmutableRuntimeEvents(sessionId, id)),
  );
  return [...inherited.flat(), ...(await store.readRuntimeEvents(sessionId, runId))];
}
