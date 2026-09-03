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

import type { AgentRunEvent, AgentRunStore } from '@maka/core/agent-run';
import type { RuntimeEvent } from '@maka/core/runtime-event';
import type { RuntimeEventStore } from '@maka/core/runtime-event-store';
import type { RuntimeInvocationRecord } from '@maka/core/runtime-invocation';
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
  | 'missing_runtime_ledger'
  | 'runtime_ledger_read_failed'
  | 'runtime_terminal_missing'
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
}

export interface AgentRunInspectProjectionSummary {
  messages: StoredMessage[];
  diagnostics: RuntimeEventReadModelDiagnostic[];
}

export interface AgentRunInspectModel {
  invocation: RuntimeInvocationRecord;
  events: AgentRunEvent[];
  runtimeEvents: RuntimeEvent[];
  terminalRuntimeFact?: RuntimeEventTerminalFact;
  modelReplay?: RuntimeEventModelReplayPlan;
  projection?: AgentRunInspectProjectionSummary;
  sourceHealth: AgentRunInspectSourceHealth;
  diagnostics: AgentRunInspectDiagnostic[];
}

export interface InspectAgentRunOptions {
  sessionId: string;
  runId: string;
  invocation?: RuntimeInvocationRecord;
  isFatalReadError?: (error: unknown) => boolean;
  includeModelReplay?: boolean;
}

export type AgentRunInspectReader = Pick<AgentRunStore, 'readEvents'>;

export type RuntimeEventInspectReader = Pick<RuntimeEventStore, 'readRuntimeEvents'> &
  Required<Pick<RuntimeEventStore, 'listSessionInvocations'>>;

/**
 * One run, read from both ledgers it actually has: the RuntimeEvent spine that
 * owns its facts, and the AgentRunEvent ledger that records what the runtime did
 * operationally. There is no third record to reconcile them against any more.
 */
export async function inspectAgentRunReadModel(
  runStore: AgentRunInspectReader,
  runtimeEventStore: RuntimeEventInspectReader,
  options: InspectAgentRunOptions,
): Promise<AgentRunInspectModel> {
  const invocation = options.invocation ?? (await readInvocation(runtimeEventStore, options));
  const diagnostics: AgentRunInspectDiagnostic[] = [];
  const events = await readOperationalEvents(
    runStore,
    invocation,
    diagnostics,
    options.isFatalReadError,
  );
  const runtimeRead = await readRuntimeEvents(
    runtimeEventStore,
    invocation,
    diagnostics,
    options.isFatalReadError,
  );
  const runtimeEvents = runtimeRead.events;

  let terminalRuntimeFact: RuntimeEventTerminalFact | undefined;
  if (runtimeRead.state === 'present' && invocation.terminalEvent) {
    const terminalFactResult = classifyRuntimeEventTerminalFact(invocation, runtimeEvents);
    terminalRuntimeFact = terminalFactResult.fact;
    diagnostics.push(
      ...terminalFactResult.diagnostics.map((diagnostic) =>
        fromRuntimeReadModelDiagnostic(invocation, diagnostic),
      ),
    );
    if (!terminalRuntimeFact) {
      diagnostics.push(
        inspectDiagnostic(
          invocation,
          'runtime_terminal_missing',
          'runtime ledger has no complete terminal RuntimeEvent fact',
        ),
      );
    }
  }

  const projection =
    runtimeEvents.length > 0
      ? projectRuntimeEventsToStoredMessages(runtimeEvents, { invocations: [invocation] })
      : undefined;
  if (projection) {
    diagnostics.push(
      ...projection.diagnostics.map((diagnostic) =>
        fromRuntimeReadModelDiagnostic(invocation, diagnostic),
      ),
    );
  }

  const modelReplay =
    runtimeEvents.length > 0 && options.includeModelReplay !== false
      ? buildRuntimeEventModelReplayPlan(runtimeEvents)
      : undefined;

  return {
    invocation,
    events,
    runtimeEvents,
    ...(terminalRuntimeFact ? { terminalRuntimeFact } : {}),
    ...(modelReplay ? { modelReplay } : {}),
    ...(projection ? { projection } : {}),
    sourceHealth: {
      runtimeLedger: runtimeRead.state,
      runtimeTerminalPresent: terminalRuntimeFact !== undefined,
    },
    diagnostics,
  };
}

export async function inspectSessionRunReadModels(
  runStore: AgentRunInspectReader,
  runtimeEventStore: RuntimeEventInspectReader,
  sessionId: string,
  options: Pick<InspectAgentRunOptions, 'isFatalReadError'> = {},
): Promise<AgentRunInspectModel[]> {
  const invocations = await runtimeEventStore.listSessionInvocations(sessionId);
  const models: AgentRunInspectModel[] = [];
  for (const invocation of invocations) {
    models.push(
      await inspectAgentRunReadModel(runStore, runtimeEventStore, {
        sessionId,
        runId: invocation.runId,
        invocation,
        ...(options.isFatalReadError ? { isFatalReadError: options.isFatalReadError } : {}),
      }),
    );
  }
  return models;
}

// A run is not its invocation: a continuation is a new run on the invocation it
// resumes. This reader is addressed by run, so it looks the invocation up by the
// id it was actually given.
async function readInvocation(
  runtimeEventStore: RuntimeEventInspectReader,
  options: InspectAgentRunOptions,
): Promise<RuntimeInvocationRecord> {
  const found = (await runtimeEventStore.listSessionInvocations(options.sessionId)).find(
    (invocation) => invocation.runId === options.runId,
  );
  if (!found) throw new Error(`Runtime invocation not found: ${options.runId}`);
  return found;
}

async function readOperationalEvents(
  runStore: AgentRunInspectReader,
  invocation: RuntimeInvocationRecord,
  diagnostics: AgentRunInspectDiagnostic[],
  isFatalReadError: InspectAgentRunOptions['isFatalReadError'],
): Promise<AgentRunEvent[]> {
  try {
    const events = await runStore.readEvents(invocation.sessionId, invocation.runId);
    for (const event of events) {
      if (event.type !== 'event_corrupt') continue;
      diagnostics.push(
        inspectDiagnostic(
          invocation,
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
        invocation,
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
  invocation: RuntimeInvocationRecord,
  diagnostics: AgentRunInspectDiagnostic[],
  isFatalReadError: InspectAgentRunOptions['isFatalReadError'],
): Promise<{ state: AgentRunInspectSourceHealth['runtimeLedger']; events: RuntimeEvent[] }> {
  try {
    const events = await runtimeEventStore.readRuntimeEvents(
      invocation.sessionId,
      invocation.runId,
    );
    if (events.length === 0) {
      diagnostics.push(
        inspectDiagnostic(
          invocation,
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
        invocation,
        'runtime_ledger_read_failed',
        'RuntimeEventStore.readRuntimeEvents failed',
        errorMessage(error),
      ),
    );
    return { state: 'read_failed', events: [] };
  }
}

function fromRuntimeReadModelDiagnostic(
  invocation: RuntimeInvocationRecord,
  diagnostic: RuntimeEventReadModelDiagnostic,
): AgentRunInspectDiagnostic {
  return {
    code: diagnostic.code,
    runId: diagnostic.runId ?? invocation.runId,
    turnId: diagnostic.turnId ?? invocation.turnId,
    message: diagnostic.message,
    ...(diagnostic.eventId ? { eventId: diagnostic.eventId } : {}),
    ...(diagnostic.detail !== undefined ? { detail: diagnostic.detail } : {}),
  };
}

function inspectDiagnostic(
  invocation: RuntimeInvocationRecord,
  code: AgentRunInspectDiagnosticCode,
  message: string,
  detail?: unknown,
  eventId?: string,
): AgentRunInspectDiagnostic {
  return {
    code,
    runId: invocation.runId,
    turnId: invocation.turnId,
    message,
    ...(eventId ? { eventId } : {}),
    ...(detail !== undefined ? { detail } : {}),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
