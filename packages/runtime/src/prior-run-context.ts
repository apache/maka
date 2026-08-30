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

import type { AgentRunHeader, AgentRunStore } from '@maka/core/agent-run';
import type { RuntimeEvent } from '@maka/core/runtime-event';
import type { RuntimeEventStore } from '@maka/core/runtime-event-store';
import { isSessionInlineRun } from '@maka/core/agent-run';
import { isTerminalRuntimeEvent } from '@maka/core/runtime-event';
import type { StoredMessage } from '@maka/core/session';
import { buildRuntimeEventModelReplayPlan } from './model-history.js';
import { backfillRuntimeEventsFromStoredMessages } from './runtime-event-backfill.js';
import { classifyRuntimeEventTerminalFact } from './runtime-event-read-model.js';
import { isTerminalRunStatus } from './session-projection-helpers.js';
import { effectiveRunHeaderFromTerminalFact } from './terminal-run-commit.js';

export interface PriorRuntimeContext {
  events: RuntimeEvent[];
  runs: AgentRunHeader[];
}

export interface BuildPriorRuntimeContextInput {
  sessionId: string;
  currentRunId: string;
  currentTurnId: string;
  runStore?: AgentRunStore;
  runtimeEventStore?: RuntimeEventStore;
  runStoreAvailable: boolean;
  runtimeEventStoreAvailable: boolean;
  repairRunRuntimeLedger?: (sessionId: string, runId: string) => Promise<boolean>;
  readMessages: () => Promise<StoredMessage[]>;
}

interface PriorRunTerminalFactContext {
  events: RuntimeEvent[];
  run: AgentRunHeader;
}

export async function buildPriorRuntimeContext(
  input: BuildPriorRuntimeContextInput,
): Promise<PriorRuntimeContext | undefined> {
  if (
    !input.runStore ||
    !input.runtimeEventStore ||
    !input.runStoreAvailable ||
    !input.runtimeEventStoreAvailable
  )
    return undefined;

  const runs = await input.runStore.listSessionRuns(input.sessionId);
  const priorRuns = runs.filter(
    (run) =>
      run.runId !== input.currentRunId &&
      run.turnId !== input.currentTurnId &&
      isSessionInlineRun(run),
  );
  if (priorRuns.length === 0) return undefined;

  const ordered: Array<{ event: RuntimeEvent; runIndex: number; eventIndex: number }> = [];
  for (let runIndex = 0; runIndex < priorRuns.length; runIndex += 1) {
    const run = priorRuns[runIndex]!;
    if (!isTerminalRunStatus(run.status)) {
      const nonTerminal = await readNonTerminalPriorRun(input, run);
      if (nonTerminal.run) priorRuns[runIndex] = nonTerminal.run;
      appendEvents(ordered, nonTerminal.events, runIndex, input);
      continue;
    }
    let events = await input.runtimeEventStore.readRuntimeEvents(input.sessionId, run.runId);
    if (events.length === 0 && (await input.repairRunRuntimeLedger?.(input.sessionId, run.runId))) {
      events = await input.runtimeEventStore.readRuntimeEvents(input.sessionId, run.runId);
    }
    if (events.length === 0) {
      const recovered = await backfillMissingPriorRuntimeEvents(input, run);
      if (recovered.length === 0 || !recovered.some(isTerminalRuntimeEvent)) {
        throw new Error(
          `Cannot build model context: RuntimeEvent ledger is missing for prior run ${run.runId}`,
        );
      }
      events = recovered;
    }
    if (
      !events.some(isTerminalRuntimeEvent) &&
      (await input.repairRunRuntimeLedger?.(input.sessionId, run.runId))
    ) {
      events = await input.runtimeEventStore.readRuntimeEvents(input.sessionId, run.runId);
    }
    if (!events.some(isTerminalRuntimeEvent)) {
      throw new Error(
        `Cannot build model context: RuntimeEvent ledger has no terminal fact for prior run ${run.runId}`,
      );
    }
    let terminalFact = classifyRuntimeEventTerminalFact(run, events).fact;
    if (!terminalFact && (await input.repairRunRuntimeLedger?.(input.sessionId, run.runId))) {
      events = await input.runtimeEventStore.readRuntimeEvents(input.sessionId, run.runId);
      terminalFact = classifyRuntimeEventTerminalFact(run, events).fact;
    }
    if (!terminalFact) {
      throw new Error(
        `Cannot build model context: RuntimeEvent ledger has no valid terminal fact for prior run ${run.runId}`,
      );
    }
    priorRuns[runIndex] = effectiveRunHeaderFromTerminalFact(run, terminalFact);
    appendEvents(ordered, events, runIndex, input);
  }

  ordered.sort((a, b) => a.runIndex - b.runIndex || a.eventIndex - b.eventIndex);
  const events = ordered.map((item) => item.event);
  if (events.length === 0 || buildRuntimeEventModelReplayPlan(events).items.length === 0)
    return undefined;
  return { events, runs: priorRuns };
}

/**
 * A prior run whose header never reached a terminal status: it was stopped
 * while parked on an interaction, or the process died mid-turn. Its turn is
 * still conversation the model must see, so the ledger it does have is
 * replayed either way. Dropping the run instead would delete a whole turn —
 * the user message included — from every later turn's context, silently and
 * for good, because the header never becomes terminal on its own.
 */
async function readNonTerminalPriorRun(
  input: BuildPriorRuntimeContextInput,
  run: AgentRunHeader,
): Promise<{ events: RuntimeEvent[]; run?: AgentRunHeader }> {
  if (!input.runtimeEventStore) return { events: [] };
  // No repair attempt here, unlike the terminal branch: `repairRunTerminalFact`
  // returns false for a non-terminal header before reading anything, so calling
  // it would be a promise that only ever answers "no".
  const events = await input.runtimeEventStore
    .readRuntimeEvents(input.sessionId, run.runId)
    .catch(() => []);
  const terminalFact = classifyRuntimeEventTerminalFact(run, events).fact;
  return terminalFact
    ? { events, run: effectiveRunHeaderFromTerminalFact(run, terminalFact) }
    : { events };
}

async function backfillMissingPriorRuntimeEvents(
  input: BuildPriorRuntimeContextInput,
  run: AgentRunHeader,
): Promise<RuntimeEvent[]> {
  let messages: StoredMessage[];
  try {
    messages = await input.readMessages();
  } catch {
    return [];
  }
  return backfillRuntimeEventsFromStoredMessages({ run, messages }).events;
}

function appendEvents(
  ordered: Array<{ event: RuntimeEvent; runIndex: number; eventIndex: number }>,
  events: readonly RuntimeEvent[],
  runIndex: number,
  input: BuildPriorRuntimeContextInput,
): void {
  for (let eventIndex = 0; eventIndex < events.length; eventIndex += 1) {
    const event = events[eventIndex]!;
    if (event.runId !== input.currentRunId && event.turnId !== input.currentTurnId) {
      ordered.push({ event, runIndex, eventIndex });
    }
  }
}
