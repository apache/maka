import type { AgentRunHeader, AgentRunStore, RuntimeEvent, RuntimeEventStore } from '@maka/core';
import { isSessionInlineRun, isTerminalRuntimeEvent } from '@maka/core';
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
  parentRunId?: string;
  resumedFromRunId?: string;
  agentId?: string;
  linkedChildSession: boolean;
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
  if (input.resumedFromRunId)
    return await buildResumedChildRuntimeContext(input, input.resumedFromRunId);
  if (input.parentRunId) return undefined;
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
      const terminalFactContext = await readNonTerminalPriorRunWithTerminalFact(input, run);
      if (!terminalFactContext) continue;
      priorRuns[runIndex] = terminalFactContext.run;
      appendEvents(ordered, terminalFactContext.events, runIndex, input);
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

async function buildResumedChildRuntimeContext(
  input: BuildPriorRuntimeContextInput,
  sourceRunId: string,
): Promise<PriorRuntimeContext> {
  if (
    !input.runStore ||
    !input.runtimeEventStore ||
    !input.runStoreAvailable ||
    !input.runtimeEventStoreAvailable
  ) {
    throw new Error('Child AgentRun resume requires durable run and RuntimeEvent stores');
  }
  const sessionRuns = await input.runStore.listSessionRuns(input.sessionId);
  const runsById = new Map(sessionRuns.map((run) => [run.runId, run]));
  const reverseChain: AgentRunHeader[] = [];
  const visited = new Set<string>();
  let cursor: string | undefined = sourceRunId;
  while (cursor) {
    if (visited.has(cursor))
      throw new Error(`Child AgentRun resume lineage contains a cycle at ${cursor}`);
    visited.add(cursor);
    const run = runsById.get(cursor);
    if (!run) throw new Error(`Child AgentRun resume source ${cursor} was not found`);
    if (
      input.linkedChildSession
        ? !isSessionInlineRun(run)
        : !run.parentRunId || isSessionInlineRun(run)
    ) {
      throw new Error(`AgentRun ${cursor} is not a resumable child run`);
    }
    if (!run.agentId || run.agentId !== input.agentId) {
      throw new Error(`Child AgentRun resume profile changed at ${cursor}`);
    }
    reverseChain.push(run);
    cursor = run.resumedFromRunId ?? (input.linkedChildSession ? run.retriedFromRunId : undefined);
  }
  const effectiveRuns: AgentRunHeader[] = [];
  const events: RuntimeEvent[] = [];
  for (const run of reverseChain.reverse()) {
    const loaded = await loadRequiredChildResumeContext(input, run);
    effectiveRuns.push(loaded.run);
    events.push(...loaded.events);
  }
  const replay = buildRuntimeEventModelReplayPlan(events);
  const unsafe = replay.diagnostics.find((diagnostic) =>
    [
      'unmatched_tool_call',
      'unmatched_tool_result',
      'tool_id_mismatch',
      'unsupported_role',
      'unsupported_content',
    ].includes(diagnostic.code),
  );
  if (unsafe) throw new Error(`Child AgentRun resume history is unsafe: ${unsafe.code}`);
  const first = replay.items[0];
  if (!first || first.kind !== 'text' || first.role !== 'user') {
    throw new Error('Child AgentRun resume history has no user-anchored replay boundary');
  }
  return { events, runs: effectiveRuns };
}

async function loadRequiredChildResumeContext(
  input: BuildPriorRuntimeContextInput,
  run: AgentRunHeader,
): Promise<PriorRunTerminalFactContext> {
  let events = await input.runtimeEventStore!.readRuntimeEvents(input.sessionId, run.runId);
  if (
    (events.length === 0 || !events.some(isTerminalRuntimeEvent)) &&
    (await input.repairRunRuntimeLedger?.(input.sessionId, run.runId))
  ) {
    events = await input.runtimeEventStore!.readRuntimeEvents(input.sessionId, run.runId);
  }
  if (events.length === 0 || !events.some(isTerminalRuntimeEvent)) {
    throw new Error(`Child AgentRun resume source ${run.runId} has no terminal RuntimeEvent fact`);
  }
  const terminalFact = classifyRuntimeEventTerminalFact(run, events).fact;
  if (!terminalFact)
    throw new Error(
      `Child AgentRun resume source ${run.runId} has an invalid terminal RuntimeEvent fact`,
    );
  return { events, run: effectiveRunHeaderFromTerminalFact(run, terminalFact) };
}

async function readNonTerminalPriorRunWithTerminalFact(
  input: BuildPriorRuntimeContextInput,
  run: AgentRunHeader,
): Promise<PriorRunTerminalFactContext | undefined> {
  if (!input.runtimeEventStore) return undefined;
  const events = await input.runtimeEventStore
    .readRuntimeEvents(input.sessionId, run.runId)
    .catch(() => []);
  const terminalFact = classifyRuntimeEventTerminalFact(run, events).fact;
  return terminalFact
    ? { events, run: effectiveRunHeaderFromTerminalFact(run, terminalFact) }
    : undefined;
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
