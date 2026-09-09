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
import type { RuntimeInvocationRecord } from '@maka/core/runtime-invocation';
import { runtimeInvocationOutcome } from '@maka/core/runtime-invocation';
import type { SessionHeader } from '@maka/core/session';
import {
  AGENT_RUN_INSPECT_DOCUMENT_VERSION,
  SESSION_INSPECT_DOCUMENT_VERSION,
  type AgentRunInspectCompactionCheckpoint,
  type AgentRunInspectDocument,
  type AgentRunInspectIdentity,
  type AgentRunInspectToolFact,
  type AgentRunInspectToolSummary,
  type ExecutionInspectDiagnostic,
  type ExecutionInspectSeverity,
  type SessionInspectDocument,
} from '@maka/core/execution-inspect';
import type { ExecutionLogCoverage } from '@maka/core/execution-log-coverage';
import {
  inspectAgentRunReadModel,
  type AgentRunInspectReader,
  type AgentRunInspectDiagnostic as SourceDiagnostic,
  type InspectAgentRunOptions,
  type RuntimeEventInspectReader,
} from './agent-run-inspect.js';
import {
  isSupersededHistoryCompactCheckpoint,
  validateHistoryCompactCheckpointShape,
  type HistoryCompactCheckpoint,
} from './history-compact-checkpoint.js';

export interface SessionHeaderReader {
  readHeader(sessionId: string): Promise<SessionHeader>;
}

export interface InspectSessionDocumentOptions {
  header?: SessionHeader;
  invocations?: readonly RuntimeInvocationRecord[];
  isFatalReadError?: InspectAgentRunOptions['isFatalReadError'];
}

export async function inspectAgentRunDocument(
  runStore: AgentRunInspectReader,
  runtimeEventStore: RuntimeEventInspectReader,
  input: {
    sessionId: string;
    agentRunId: string;
    invocation?: RuntimeInvocationRecord;
    isFatalReadError?: InspectAgentRunOptions['isFatalReadError'];
  },
): Promise<AgentRunInspectDocument> {
  const model = await inspectAgentRunReadModel(runStore, runtimeEventStore, {
    sessionId: input.sessionId,
    runId: input.agentRunId,
    ...(input.invocation ? { invocation: input.invocation } : {}),
    ...(input.isFatalReadError ? { isFatalReadError: input.isFatalReadError } : {}),
    includeModelReplay: false,
  });
  const diagnostics = model.diagnostics.map((item) => sourceDiagnostic(model.invocation, item));
  const tools = inspectTools(model.invocation, model.runtimeEvents, diagnostics);
  const compactionCheckpoints = inspectCompactionCheckpoints(
    model.invocation,
    model.events,
    diagnostics,
  );
  const runtimeCoverage = coverageFor(model.invocation.runId, model.runtimeEvents);

  return {
    schemaVersion: AGENT_RUN_INSPECT_DOCUMENT_VERSION,
    kind: 'agent_run',
    agentRun: inspectIdentity(model.invocation),
    sources: {
      operationalEventCount: model.events.length,
      runtimeEventCount: model.runtimeEvents.length,
      ...(runtimeCoverage ? { runtimeCoverage } : {}),
      health: model.sourceHealth,
    },
    tools,
    compactionCheckpoints,
    diagnostics,
  };
}

export async function inspectSessionDocument(
  sessionStore: SessionHeaderReader,
  runStore: AgentRunInspectReader,
  runtimeEventStore: RuntimeEventInspectReader,
  sessionId: string,
  options: InspectSessionDocumentOptions = {},
): Promise<SessionInspectDocument> {
  const resolvedHeader = options.header ?? (await sessionStore.readHeader(sessionId));
  const invocations =
    options.invocations ?? (await runtimeEventStore.listSessionInvocations(sessionId));
  const agentRuns: AgentRunInspectDocument[] = [];
  for (const invocation of invocations) {
    agentRuns.push(
      await inspectAgentRunDocument(runStore, runtimeEventStore, {
        sessionId,
        agentRunId: invocation.runId,
        invocation,
        ...(options.isFatalReadError ? { isFatalReadError: options.isFatalReadError } : {}),
      }),
    );
  }
  return {
    schemaVersion: SESSION_INSPECT_DOCUMENT_VERSION,
    kind: 'session',
    session: {
      sessionId: resolvedHeader.id,
      name: resolvedHeader.name,
      status: resolvedHeader.status,
      createdAt: resolvedHeader.createdAt,
      ...(resolvedHeader.lastMessageAt !== undefined
        ? { lastMessageAt: resolvedHeader.lastMessageAt }
        : {}),
      isArchived: resolvedHeader.isArchived,
      ...(resolvedHeader.parentSessionId
        ? { parentSessionId: resolvedHeader.parentSessionId }
        : {}),
      ...(resolvedHeader.branchOfTurnId ? { branchOfTurnId: resolvedHeader.branchOfTurnId } : {}),
      ...(resolvedHeader.revisionRootSessionId
        ? { revisionRootSessionId: resolvedHeader.revisionRootSessionId }
        : {}),
      ...(resolvedHeader.revisionParentSessionId
        ? { revisionParentSessionId: resolvedHeader.revisionParentSessionId }
        : {}),
      ...(resolvedHeader.revisionOfTurnId
        ? { revisionOfTurnId: resolvedHeader.revisionOfTurnId }
        : {}),
      ...(resolvedHeader.revisionIndex !== undefined
        ? { revisionIndex: resolvedHeader.revisionIndex }
        : {}),
      ...(resolvedHeader.revisionState ? { revisionState: resolvedHeader.revisionState } : {}),
    },
    agentRuns,
    diagnostics: agentRuns.flatMap((run) => run.diagnostics),
  };
}

export function renderAgentRunInspectTree(document: AgentRunInspectDocument): string {
  const run = document.agentRun;
  const lines = [
    `AgentRun ${run.agentRunId} [${run.status}]`,
    `├─ Session ${run.sessionId}`,
    `├─ Turn ${run.turnId}`,
    `├─ Runtime Events ${formatCoverage(document.sources.runtimeCoverage)} (${document.sources.runtimeEventCount})`,
    `├─ Operational Events ${document.sources.operationalEventCount}`,
    `├─ Source Health [runtime ledger ${document.sources.health.runtimeLedger}]`,
    `├─ Tools ${document.tools.callCount} calls / ${document.tools.responseCount} responses`,
  ];
  for (const checkpoint of document.compactionCheckpoints) {
    lines.push(
      `├─ Compaction ${checkpoint.checkpointId ?? checkpoint.eventId} ${formatCoverage(checkpoint.sourceCoverage)} [${checkpoint.validation}]`,
    );
  }
  appendDiagnostics(lines, document.diagnostics);
  if (document.diagnostics.length === 0) lines.push('└─ Diagnostics (0)');
  return `${lines.join('\n')}\n`;
}

export function renderSessionInspectTree(document: SessionInspectDocument): string {
  const lines = [`Session ${document.session.sessionId} [${document.session.status}]`];
  if (document.agentRuns.length === 0) {
    lines.push('└─ AgentRuns (0)');
    return `${lines.join('\n')}\n`;
  }
  document.agentRuns.forEach((run, index) => {
    const last = index === document.agentRuns.length - 1;
    const branch = last ? '└─' : '├─';
    const child = last ? '   ' : '│  ';
    lines.push(`${branch} AgentRun ${run.agentRun.agentRunId} [${run.agentRun.status}]`);
    lines.push(`${child}├─ Turn ${run.agentRun.turnId}`);
    lines.push(
      `${child}├─ Runtime Events ${formatCoverage(run.sources.runtimeCoverage)} (${run.sources.runtimeEventCount})`,
    );
    lines.push(
      `${child}├─ Tools ${run.tools.callCount} calls / ${run.tools.responseCount} responses`,
    );
    lines.push(`${child}└─ Diagnostics (${run.diagnostics.length})`);
  });
  return `${lines.join('\n')}\n`;
}

function inspectIdentity(invocation: RuntimeInvocationRecord): AgentRunInspectIdentity {
  const lineage = invocation.opening.lineage;
  const terminal = invocation.terminalEvent;
  const stateDelta = terminal?.actions?.stateDelta;
  const failureClass =
    typeof stateDelta?.failureClass === 'string' ? stateDelta.failureClass : undefined;
  const abortSource =
    typeof stateDelta?.abortSource === 'string' ? stateDelta.abortSource : undefined;
  return {
    sessionId: invocation.sessionId,
    agentRunId: invocation.runId,
    invocationId: invocation.invocationId,
    turnId: invocation.turnId,
    ...(lineage?.parentRunId ? { parentRunId: lineage.parentRunId } : {}),
    ...(lineage?.resumedFromRunId ? { resumedFromRunId: lineage.resumedFromRunId } : {}),
    ...(lineage?.retriedFromRunId ? { retriedFromRunId: lineage.retriedFromRunId } : {}),
    ...(lineage?.parentTurnId ? { parentTurnId: lineage.parentTurnId } : {}),
    ...(lineage?.agentId ? { agentId: lineage.agentId } : {}),
    status: runtimeInvocationOutcome(invocation) ?? 'running',
    openedAt: invocation.openedAt,
    ...(terminal ? { endedAt: terminal.ts } : {}),
    ...(failureClass ? { failureClass } : {}),
    ...(abortSource ? { abortSource } : {}),
  };
}

function inspectTools(
  invocation: RuntimeInvocationRecord,
  events: readonly RuntimeEvent[],
  diagnostics: ExecutionInspectDiagnostic[],
): AgentRunInspectToolSummary {
  const calls = new Map<string, AgentRunInspectToolFact>();
  const responses = new Map<string, AgentRunInspectToolFact & { isError: boolean }>();
  for (const event of events) {
    if (event.content?.kind === 'function_call') {
      calls.set(event.content.id, {
        toolCallId: event.content.id,
        toolName: event.content.name,
        eventId: event.id,
      });
    } else if (event.content?.kind === 'function_response') {
      responses.set(event.content.id, {
        toolCallId: event.content.id,
        toolName: event.content.name,
        eventId: event.id,
        isError: event.content.isError === true,
      });
    }
  }
  const callsWithoutResponse = [...calls.values()].filter(
    (call) => !responses.has(call.toolCallId),
  );
  const responsesWithoutCall = [...responses.values()]
    .filter((response) => !calls.has(response.toolCallId))
    .map(({ isError: _isError, ...response }) => response);
  for (const call of callsWithoutResponse) {
    diagnostics.push(
      diagnostic(
        invocation,
        'tool_response_missing',
        'warning',
        `Tool Call ${call.toolCallId} has no committed Runtime response; its outcome and external side effects are unknown.`,
        call.eventId,
      ),
    );
  }
  for (const response of responsesWithoutCall) {
    diagnostics.push(
      diagnostic(
        invocation,
        'tool_call_missing',
        'warning',
        `Tool response ${response.toolCallId} has no matching Runtime call fact.`,
        response.eventId,
      ),
    );
  }
  return {
    callCount: calls.size,
    responseCount: responses.size,
    errorResponseCount: [...responses.values()].filter((response) => response.isError).length,
    callsWithoutResponse,
    responsesWithoutCall,
  };
}

function inspectCompactionCheckpoints(
  invocation: RuntimeInvocationRecord,
  events: readonly { type: string; id: string; data?: Record<string, unknown> }[],
  diagnostics: ExecutionInspectDiagnostic[],
): AgentRunInspectCompactionCheckpoint[] {
  const checkpoints: AgentRunInspectCompactionCheckpoint[] = [];
  for (const event of events) {
    if (event.type !== 'history_compact_checkpoint_recorded') continue;
    const checkpoint = event.data?.checkpoint;
    if (!validateHistoryCompactCheckpointShape(checkpoint, invocation.sessionId)) {
      // A checkpoint recorded under an older source policy is expected history,
      // not corruption: the ledger keeps every checkpoint it ever wrote, and
      // every consumer fails open on it. Reporting it as an error would drown
      // out the records that really are damaged.
      const superseded = isSupersededHistoryCompactCheckpoint(checkpoint);
      diagnostics.push(
        diagnostic(
          invocation,
          superseded ? 'compaction_checkpoint_superseded' : 'compaction_checkpoint_invalid',
          superseded ? 'info' : 'error',
          superseded
            ? 'AgentRun contains a durable Compaction checkpoint from a superseded source policy; it is ignored and re-created on demand.'
            : 'AgentRun contains an invalid durable Compaction checkpoint record.',
          event.id,
        ),
      );
      checkpoints.push({
        eventId: event.id,
        validation: superseded ? 'superseded' : 'invalid',
      });
      continue;
    }
    const valid = checkpoint as HistoryCompactCheckpoint;
    checkpoints.push({
      eventId: event.id,
      validation: 'shape_valid',
      checkpointId: valid.checkpointId,
      ...(valid.source?.policyVersion ? { policyVersion: valid.source.policyVersion } : {}),
      ...(valid.source?.coverage ? { sourceCoverage: valid.source.coverage } : {}),
    });
  }
  return checkpoints;
}

function sourceDiagnostic(
  invocation: RuntimeInvocationRecord,
  source: SourceDiagnostic,
): ExecutionInspectDiagnostic {
  const severity: ExecutionInspectSeverity = /read_failed|corrupt|mismatch/.test(source.code)
    ? 'error'
    : source.code.includes('missing')
      ? 'warning'
      : 'info';
  return diagnostic(invocation, source.code, severity, source.message, source.eventId);
}

function diagnostic(
  invocation: RuntimeInvocationRecord,
  code: string,
  severity: ExecutionInspectSeverity,
  message: string,
  eventId?: string,
): ExecutionInspectDiagnostic {
  return {
    severity,
    code,
    message,
    sessionId: invocation.sessionId,
    agentRunId: invocation.runId,
    turnId: invocation.turnId,
    ...(eventId ? { eventId } : {}),
  };
}

function coverageFor(
  runId: string,
  events: readonly RuntimeEvent[],
): ExecutionLogCoverage | undefined {
  const first = events[0];
  const last = events.at(-1);
  if (!first || !last) return undefined;
  return {
    lowWater: { ledger: 'runtime_event', streamId: runId, sequence: 0, eventId: first.id },
    highWater: {
      ledger: 'runtime_event',
      streamId: runId,
      sequence: events.length - 1,
      eventId: last.id,
    },
    eventCount: events.length,
  };
}

function appendDiagnostics(
  lines: string[],
  diagnostics: readonly ExecutionInspectDiagnostic[],
): void {
  if (diagnostics.length === 0) return;
  lines.push(`└─ Diagnostics (${diagnostics.length})`);
  diagnostics.forEach((item, index) => {
    lines.push(
      `   ${index === diagnostics.length - 1 ? '└─' : '├─'} ${item.severity.toUpperCase()} ${item.code}: ${item.message}`,
    );
  });
}

function formatCoverage(coverage: ExecutionLogCoverage | undefined): string {
  if (!coverage) return 'unknown';
  const low = coverage.lowWater?.sequence ?? 0;
  return `${coverage.highWater.ledger}:${coverage.highWater.streamId} ${low}–${coverage.highWater.sequence}`;
}
