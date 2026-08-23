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

import type { AgentRunEvent, AgentRunHeader, AgentRunStore } from '@maka/core/agent-run';
import type { RuntimeEvent } from '@maka/core/runtime-event';
import type { RuntimeEventStore } from '@maka/core/runtime-event-store';
import type { StoredMessage } from '@maka/core/session';
import {
  classifyRuntimeEventTerminalFact,
  projectRuntimeEventsToStoredMessages,
  type RuntimeEventReadModelDiagnostic,
  type RuntimeEventTerminalFact,
} from './runtime-event-read-model.js';
import {
  buildRuntimeEventModelReplayPlan,
  type RuntimeEventModelReplayPlan,
} from './model-history.js';

export type AgentRunInspectDiagnosticCode =
  | 'operational_ledger_read_failed'
  | 'operational_event_corrupt'
  | 'operational_terminal_missing'
  | 'missing_runtime_ledger'
  | 'runtime_ledger_read_failed'
  | 'runtime_terminal_missing'
  | 'status_consistency_mismatch'
  | RuntimeEventReadModelDiagnostic['code'];

export interface AgentRunInspectDiagnostic {
  code: AgentRunInspectDiagnosticCode;
  runId: string;
  turnId: string;
  message: string;
  eventId?: string;
  detail?: unknown;
}

export interface AgentRunInspectSourceHealth {
  runtimeLedger: 'present' | 'missing' | 'read_failed';
  runtimeTerminalPresent: boolean;
  operationalTerminalPresent: boolean;
  statusConsistency: 'consistent' | 'inconsistent' | 'incomplete';
}

export interface AgentRunInspectProjectionSummary {
  messages: StoredMessage[];
  diagnostics: RuntimeEventReadModelDiagnostic[];
}

export interface AgentRunInspectModel {
  header: AgentRunHeader;
  events: AgentRunEvent[];
  runtimeEvents: RuntimeEvent[];
  terminalRuntimeFact?: RuntimeEventTerminalFact;
  operationalTerminalEvent?: AgentRunEvent;
  modelReplay?: RuntimeEventModelReplayPlan;
  projection?: AgentRunInspectProjectionSummary;
  sourceHealth: AgentRunInspectSourceHealth;
  diagnostics: AgentRunInspectDiagnostic[];
}

export interface InspectAgentRunOptions {
  sessionId: string;
  runId: string;
  header?: AgentRunHeader;
  isFatalReadError?: (error: unknown) => boolean;
  includeModelReplay?: boolean;
}

export type AgentRunInspectReader = Pick<AgentRunStore, 'readRun' | 'readEvents'>;

export type SessionAgentRunInspectReader = AgentRunInspectReader &
  Pick<AgentRunStore, 'listSessionRuns'>;

export type RuntimeEventInspectReader = Pick<RuntimeEventStore, 'readRuntimeEvents'>;

export async function inspectAgentRunReadModel(
  runStore: AgentRunInspectReader,
  runtimeEventStore: RuntimeEventInspectReader,
  options: InspectAgentRunOptions,
): Promise<AgentRunInspectModel> {
  const header = options.header ?? (await runStore.readRun(options.sessionId, options.runId));
  const diagnostics: AgentRunInspectDiagnostic[] = [];
  const events = await readOperationalEvents(
    runStore,
    header,
    diagnostics,
    options.isFatalReadError,
  );
  const runtimeRead = await readRuntimeEvents(
    runtimeEventStore,
    header,
    diagnostics,
    options.isFatalReadError,
  );
  const runtimeEvents = runtimeRead.events;

  const operationalTerminalEvent = latestOperationalTerminalEvent(events);
  if (!operationalTerminalEvent) {
    diagnostics.push(
      inspectDiagnostic(
        header,
        'operational_terminal_missing',
        'operational AgentRunEvent ledger has no terminal run event',
      ),
    );
  }

  let terminalRuntimeFact: RuntimeEventTerminalFact | undefined;
  if (runtimeRead.state === 'present') {
    const terminalFactResult = classifyRuntimeEventTerminalFact(header, runtimeEvents);
    terminalRuntimeFact = terminalFactResult.fact;
    diagnostics.push(
      ...terminalFactResult.diagnostics.map((diagnostic) =>
        fromRuntimeReadModelDiagnostic(header, diagnostic),
      ),
    );
    if (!terminalRuntimeFact) {
      diagnostics.push(
        inspectDiagnostic(
          header,
          'runtime_terminal_missing',
          'runtime ledger has no complete terminal RuntimeEvent fact',
        ),
      );
    }
  }

  const projection =
    runtimeEvents.length > 0
      ? projectRuntimeEventsToStoredMessages(runtimeEvents, { runHeaders: [header] })
      : undefined;
  if (projection) {
    diagnostics.push(
      ...projection.diagnostics.map((diagnostic) =>
        fromRuntimeReadModelDiagnostic(header, diagnostic),
      ),
    );
  }

  const modelReplay =
    runtimeEvents.length > 0 && options.includeModelReplay !== false
      ? buildRuntimeEventModelReplayPlan(runtimeEvents)
      : undefined;

  const statusConsistency = computeStatusConsistency(
    header,
    operationalTerminalEvent,
    terminalRuntimeFact,
  );
  if (statusConsistency === 'inconsistent') {
    diagnostics.push(
      inspectDiagnostic(
        header,
        'status_consistency_mismatch',
        'AgentRunHeader, operational terminal event, and RuntimeEvent terminal fact disagree',
        {
          headerStatus: header.status,
          operationalStatus: operationalTerminalEvent
            ? operationalStatusFor(operationalTerminalEvent)
            : undefined,
          runtimeStatus: terminalRuntimeFact?.runStatus,
        },
      ),
    );
  }

  return {
    header,
    events,
    runtimeEvents,
    ...(terminalRuntimeFact ? { terminalRuntimeFact } : {}),
    ...(operationalTerminalEvent ? { operationalTerminalEvent } : {}),
    ...(modelReplay ? { modelReplay } : {}),
    ...(projection ? { projection } : {}),
    sourceHealth: {
      runtimeLedger: runtimeRead.state,
      runtimeTerminalPresent: terminalRuntimeFact !== undefined,
      operationalTerminalPresent: operationalTerminalEvent !== undefined,
      statusConsistency,
    },
    diagnostics,
  };
}

export async function inspectSessionRunReadModels(
  runStore: SessionAgentRunInspectReader,
  runtimeEventStore: RuntimeEventInspectReader,
  sessionId: string,
  options: Pick<InspectAgentRunOptions, 'isFatalReadError'> = {},
): Promise<AgentRunInspectModel[]> {
  const headers = await runStore.listSessionRuns(sessionId);
  const models: AgentRunInspectModel[] = [];
  for (const header of headers) {
    models.push(
      await inspectAgentRunReadModel(runStore, runtimeEventStore, {
        sessionId,
        runId: header.runId,
        header,
        ...(options.isFatalReadError ? { isFatalReadError: options.isFatalReadError } : {}),
      }),
    );
  }
  return models;
}

async function readOperationalEvents(
  runStore: AgentRunInspectReader,
  header: AgentRunHeader,
  diagnostics: AgentRunInspectDiagnostic[],
  isFatalReadError: InspectAgentRunOptions['isFatalReadError'],
): Promise<AgentRunEvent[]> {
  try {
    const events = await runStore.readEvents(header.sessionId, header.runId);
    for (const event of events) {
      if (event.type !== 'event_corrupt') continue;
      diagnostics.push(
        inspectDiagnostic(
          header,
          'operational_event_corrupt',
          'operational AgentRunEvent ledger contains a corrupt row',
          event.data,
          event.id,
        ),
      );
    }
    return events;
  } catch (error) {
    if (isFatalReadError?.(error)) throw error;
    diagnostics.push(
      inspectDiagnostic(
        header,
        'operational_ledger_read_failed',
        'AgentRunStore.readEvents failed',
        errorMessage(error),
      ),
    );
    return [];
  }
}

async function readRuntimeEvents(
  runtimeEventStore: RuntimeEventInspectReader,
  header: AgentRunHeader,
  diagnostics: AgentRunInspectDiagnostic[],
  isFatalReadError: InspectAgentRunOptions['isFatalReadError'],
): Promise<{ state: AgentRunInspectSourceHealth['runtimeLedger']; events: RuntimeEvent[] }> {
  try {
    const events = await runtimeEventStore.readRuntimeEvents(header.sessionId, header.runId);
    if (events.length === 0) {
      diagnostics.push(
        inspectDiagnostic(
          header,
          'missing_runtime_ledger',
          'runtime-events ledger is missing or empty for this run',
        ),
      );
      return { state: 'missing', events };
    }
    return { state: 'present', events };
  } catch (error) {
    if (isFatalReadError?.(error)) throw error;
    diagnostics.push(
      inspectDiagnostic(
        header,
        'runtime_ledger_read_failed',
        'RuntimeEventStore.readRuntimeEvents failed',
        errorMessage(error),
      ),
    );
    return { state: 'read_failed', events: [] };
  }
}

function computeStatusConsistency(
  header: AgentRunHeader,
  operationalTerminalEvent: AgentRunEvent | undefined,
  terminalRuntimeFact: RuntimeEventTerminalFact | undefined,
): AgentRunInspectSourceHealth['statusConsistency'] {
  const statuses = [
    isTerminalRunStatus(header.status) ? header.status : undefined,
    operationalTerminalEvent ? operationalStatusFor(operationalTerminalEvent) : undefined,
    terminalRuntimeFact?.runStatus,
  ].filter((status): status is 'completed' | 'failed' | 'cancelled' => status !== undefined);

  if (statuses.length < 2) return 'incomplete';
  return statuses.every((status) => status === statuses[0]) ? 'consistent' : 'inconsistent';
}

function latestOperationalTerminalEvent(
  events: readonly AgentRunEvent[],
): AgentRunEvent | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!event) continue;
    if (operationalStatusFor(event)) return event;
  }
  return undefined;
}

function operationalStatusFor(
  event: AgentRunEvent,
): 'completed' | 'failed' | 'cancelled' | undefined {
  if (event.type === 'run_completed') return 'completed';
  if (event.type === 'run_failed') return 'failed';
  if (event.type === 'run_cancelled') return 'cancelled';
  return undefined;
}

function isTerminalRunStatus(
  status: AgentRunHeader['status'],
): status is 'completed' | 'failed' | 'cancelled' {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

function fromRuntimeReadModelDiagnostic(
  header: AgentRunHeader,
  diagnostic: RuntimeEventReadModelDiagnostic,
): AgentRunInspectDiagnostic {
  return {
    code: diagnostic.code,
    runId: diagnostic.runId ?? header.runId,
    turnId: diagnostic.turnId ?? header.turnId,
    message: diagnostic.message,
    ...(diagnostic.eventId ? { eventId: diagnostic.eventId } : {}),
    ...(diagnostic.detail !== undefined ? { detail: diagnostic.detail } : {}),
  };
}

function inspectDiagnostic(
  header: AgentRunHeader,
  code: AgentRunInspectDiagnosticCode,
  message: string,
  detail?: unknown,
  eventId?: string,
): AgentRunInspectDiagnostic {
  return {
    code,
    runId: header.runId,
    turnId: header.turnId,
    message,
    ...(eventId ? { eventId } : {}),
    ...(detail !== undefined ? { detail } : {}),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
