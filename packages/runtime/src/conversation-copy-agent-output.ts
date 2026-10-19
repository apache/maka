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

import { isRecord, isStringArray } from '@maka/core/record-schema';
import { decodeAgentRunEvent } from '@maka/core/agent-run';
import {
  decodeRuntimeEvent,
  decodeRuntimeInvocationOpened,
  type RuntimeEvent,
} from '@maka/core/runtime-event';
import { runtimeInvocationOutcome } from '@maka/core/runtime-invocation';
import { stableJsonStringify } from '@maka/core/tool-args-identity';
import { runtimeInvocationFailureClass } from './runtime-event-read-model.js';
import type { ConversationCopyLinkedChildReference } from './conversation-copy.js';

/** Child references in every agent_output view, including historical JSON envelopes. */
export interface ConversationCopyAgentOutput {
  readonly reference: ConversationCopyLinkedChildReference & {
    readonly runId: string;
    readonly turnId: string;
  };
  readonly snapshot: ConversationCopyAgentOutputSnapshot;
}

/** Session-owned result data that remains recognizable on subsequent copies. */
export interface ConversationCopyAgentOutputSnapshot {
  readonly kind: 'maka.agent_output_snapshot';
  readonly schemaVersion: 1;
  readonly status: ConversationCopyLinkedChildReference['status'];
  readonly text?: string;
  readonly textTruncated: boolean;
  readonly artifactIds: readonly string[];
  readonly omittedArtifactIds: number;
  readonly failureClass?: string;
}

export function isConversationCopyAgentOutputSnapshot(
  value: unknown,
): value is ConversationCopyAgentOutputSnapshot {
  return (
    isRecord(value) &&
    value.kind === 'maka.agent_output_snapshot' &&
    isResultPayload(value) &&
    Object.keys(value).every((key) =>
      [
        'kind',
        'schemaVersion',
        'status',
        'text',
        'textTruncated',
        'artifactIds',
        'omittedArtifactIds',
        'failureClass',
      ].includes(key),
    )
  );
}

function isResultPayload(
  value: Record<string, unknown>,
): value is Record<string, unknown> & Omit<ConversationCopyAgentOutputSnapshot, 'kind'> {
  return (
    value.schemaVersion === 1 &&
    resultStatus(value.status) &&
    isStringArray(value.artifactIds) &&
    value.artifactIds.every(nonempty) &&
    typeof value.textTruncated === 'boolean' &&
    typeof value.omittedArtifactIds === 'number' &&
    Number.isSafeInteger(value.omittedArtifactIds) &&
    value.omittedArtifactIds >= 0 &&
    (value.text === undefined || typeof value.text === 'string') &&
    (value.failureClass === undefined || typeof value.failureClass === 'string')
  );
}

/**
 * Recognize the defined result envelope, never arbitrary nested JSON ids.
 * These are reference claims, not authority: the Host still checks them against
 * the retained child's metadata, invocation ledger, and Artifact ownership.
 */
export function conversationCopyAgentOutput(
  value: unknown,
): ConversationCopyAgentOutput | undefined {
  if (!isRecord(value)) return undefined;
  const { execution, invocation, budget } = value;
  if (
    !isRecord(execution) ||
    execution.kind !== 'child_session' ||
    !nonempty(execution.sessionId) ||
    !isRecord(invocation) ||
    invocation.sessionId !== execution.sessionId ||
    !nonempty(invocation.runId) ||
    !nonempty(invocation.turnId) ||
    !nonempty(invocation.invocationId) ||
    (execution.currentRunId !== undefined && execution.currentRunId !== invocation.runId) ||
    !isRecord(budget) ||
    typeof budget.view !== 'string' ||
    !['result', 'events', 'runtime_events', 'all'].includes(budget.view) ||
    !Array.isArray(value.events) ||
    !Array.isArray(value.runtimeEvents) ||
    !Array.isArray(value.diagnostics) ||
    !Array.isArray(value.artifacts)
  )
    return undefined;

  try {
    const opening = decodeRuntimeInvocationOpened(invocation.opening);
    const terminal =
      invocation.terminalEvent === undefined
        ? undefined
        : decodeRuntimeEvent(invocation.terminalEvent);
    if (
      terminal &&
      (terminal.sessionId !== execution.sessionId ||
        terminal.runId !== invocation.runId ||
        terminal.turnId !== invocation.turnId ||
        terminal.invocationId !== invocation.invocationId ||
        terminal.partial)
    )
      return undefined;
    let result = value.result;
    if (budget.view === 'result') {
      if (
        value.events.length ||
        value.runtimeEvents.length ||
        value.diagnostics.length ||
        value.artifacts.length
      )
        return undefined;
    } else {
      // Diagnostic views have no committed-result field. Their invocation
      // still identifies the observation, and their Artifact list can contain
      // outputs omitted by a separately bounded view=result read.
      if (
        result !== undefined ||
        (budget.view === 'events' && value.runtimeEvents.length > 0) ||
        (budget.view === 'runtime_events' && value.events.length > 0)
      )
        return undefined;
      const sameRun = (event: { sessionId: string; runId: string; turnId: string }) =>
        event.sessionId === execution.sessionId &&
        event.runId === invocation.runId &&
        event.turnId === invocation.turnId;
      const events = value.events.map(decodeAgentRunEvent);
      const runtimeEvents = value.runtimeEvents.map(decodeRuntimeEvent);
      if (
        !events.every(sameRun) ||
        !runtimeEvents.every(
          (event) => sameRun(event) && event.invocationId === invocation.invocationId,
        ) ||
        !value.diagnostics.every(
          (item) =>
            isRecord(item) &&
            item.runId === invocation.runId &&
            item.turnId === invocation.turnId &&
            nonempty(item.code) &&
            typeof item.message === 'string',
        ) ||
        !value.artifacts.every(
          (item) =>
            isRecord(item) &&
            nonempty(item.id) &&
            item.sessionId === execution.sessionId &&
            item.turnId === invocation.turnId,
        )
      )
        return undefined;
      const text = [
        ...runtimeEvents.flatMap(diagnosticRuntimeEventText),
        ...events.flatMap((event) => (event.message ? [event.message] : [])),
        ...value.diagnostics.map((item) => item.message as string),
      ].join('\n');
      const failureClass = runtimeInvocationFailureClass({ terminalEvent: terminal });
      result = {
        schemaVersion: 1,
        status: runtimeInvocationOutcome({ terminalEvent: terminal }) ?? 'running',
        ...(text ? { text } : {}),
        // The bounded diagnostic view cannot establish a complete final text
        // or count omitted Artifacts. Retain its readable excerpt and known ids.
        textTruncated: true,
        artifactIds: value.artifacts.map((item) => item.id as string),
        omittedArtifactIds: 0,
        ...(failureClass ? { failureClass } : {}),
      };
    }
    if (!isRecord(result) || !isResultPayload(result)) return undefined;
    if (
      terminal &&
      (runtimeInvocationOutcome({ terminalEvent: terminal }) !== result.status ||
        (result.terminalRuntimeEventId !== undefined &&
          result.terminalRuntimeEventId !== terminal.id))
    )
      return undefined;
    if (!terminal && result.status !== 'running' && result.status !== 'waiting_for_user')
      return undefined;
    let graph: ConversationCopyLinkedChildReference['graph'];
    if (result.graph !== undefined) {
      if (
        !isRecord(result.graph) ||
        !nonempty(result.graph.graphId) ||
        !nonempty(result.graph.workId) ||
        !nonempty(result.graph.operatorId)
      )
        return undefined;
      graph = {
        graphId: result.graph.graphId,
        workId: result.graph.workId,
        operatorId: result.graph.operatorId,
      };
    }
    return {
      reference: {
        childSessionId: execution.sessionId,
        runId: invocation.runId,
        turnId: invocation.turnId,
        status: result.status,
        artifactIds: result.artifactIds,
        ...(result.failureClass ? { failureClass: result.failureClass } : {}),
        ...(opening.lineage?.resumedFromRunId
          ? { resumedFromRunId: opening.lineage.resumedFromRunId }
          : {}),
        ...(terminal ? { terminalEventId: terminal.id } : {}),
        ...(graph ? { graph } : {}),
      },
      // An independent Side Conversation keeps a result snapshot, without the
      // original execution, invocation, Graph, or event identities.
      snapshot: {
        kind: 'maka.agent_output_snapshot',
        schemaVersion: 1,
        status: result.status,
        ...(typeof result.text === 'string' ? { text: result.text } : {}),
        textTruncated: result.textTruncated,
        artifactIds: result.artifactIds,
        omittedArtifactIds: result.omittedArtifactIds,
        ...(result.failureClass ? { failureClass: result.failureClass } : {}),
      },
    };
  } catch {
    return undefined;
  }
}

/** Keep tool evidence as static text without copying event or tool-call identities. */
function diagnosticRuntimeEventText(event: RuntimeEvent): string[] {
  if (event.partial) return [];
  const content = event.content;
  switch (content?.kind) {
    case 'text':
      return [content.text];
    case 'function_call':
      return [stableJsonStringify({ kind: content.kind, name: content.name, args: content.args })];
    case 'function_response':
      return [
        stableJsonStringify({
          kind: content.kind,
          name: content.name,
          result: content.result,
          ...(content.isError !== undefined ? { isError: content.isError } : {}),
        }),
      ];
    default:
      return [];
  }
}

function nonempty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function resultStatus(value: unknown): value is ConversationCopyLinkedChildReference['status'] {
  return (
    value === 'completed' ||
    value === 'failed' ||
    value === 'cancelled' ||
    value === 'running' ||
    value === 'waiting_for_user'
  );
}
