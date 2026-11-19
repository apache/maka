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
import type {
  AgentDelivery,
  DisplayText,
  RunId,
  StepId,
  ModelAttemptId,
} from '../../../../packages/plugin-sdk/src/index.js';

// Display-only source observations. No preview is parsed or used to authorize a tool.
export type ToolActivity = {
  runId: RunId;
  turnId: string;
  toolUseId: string;
  stepId?: StepId;
  attemptId?: ModelAttemptId;
  startSequence: number;
  previewOrder?: number;
  name: string;
  title?: DisplayText;
  source: 'native' | 'provider' | 'executor';
  phase: 'preparing' | 'running';
  inputReady: boolean;
  detail: string;
};

export function updateToolActivity(active: ToolActivity[], event: AgentDelivery): ToolActivity[] {
  const fact = event.fact;
  const toolUseId = 'toolUseId' in fact ? fact.toolUseId : null;
  const matches = (tool: ToolActivity) =>
    tool.runId === event.runId && tool.toolUseId === toolUseId;
  const previous = active.find(matches);
  const start = (
    source: ToolActivity['source'],
    phase: ToolActivity['phase'],
    tool: Extract<AgentDelivery['fact'], { toolUseId: string; name: string }>,
  ): ToolActivity => ({
    runId: event.runId,
    turnId: event.turnId,
    toolUseId: tool.toolUseId,
    startSequence: event.sequence,
    name: tool.name,
    source,
    phase,
    inputReady: false,
    detail: '',
  });
  let next: ToolActivity;
  switch (fact.kind) {
    case 'tool_input_ready':
      next = {
        ...(previous ?? start(fact.providerExecuted ? 'provider' : 'native', 'preparing', fact)),
        stepId: fact.stepId,
        attemptId: fact.attemptId,
        name: fact.name,
        source: fact.providerExecuted ? 'provider' : 'native',
        startSequence:
          previous?.previewOrder === undefined
            ? (previous?.startSequence ?? event.sequence)
            : event.sequence,
        previewOrder: undefined,
        inputReady: true,
        phase: fact.providerExecuted ? 'running' : 'preparing',
      };
      break;
    case 'tool_dispatched':
      next = {
        ...(previous ?? start('native', 'running', fact)),
        source: 'native',
        previewOrder: undefined,
        startSequence:
          previous?.previewOrder === undefined
            ? (previous?.startSequence ?? event.sequence)
            : event.sequence,
        phase: 'running',
        name: fact.name,
        title: fact.title ?? undefined,
      };
      break;
    case 'executor_tool_start':
      next = {
        ...(previous ?? start('executor', 'running', fact)),
        source: 'executor',
        phase: 'running',
        name: fact.name,
        title: fact.title ?? undefined,
        inputReady: true,
      };
      break;
    case 'executor_tool_progress':
      if (!previous || previous.source !== 'executor') return active;
      next = { ...previous, detail: fact.text };
      break;
    case 'tool_rejected':
    case 'tool_settled':
    case 'provider_tool_result':
    case 'executor_tool_result':
      return previous ? active.filter((tool) => !matches(tool)) : active;
    case 'step_ended':
      return active.filter(
        (tool) =>
          tool.runId !== event.runId ||
          tool.stepId !== fact.stepId ||
          tool.attemptId !== fact.attemptId ||
          (tool.source === 'native' &&
            (tool.phase === 'running' || (fact.completed && tool.inputReady))),
      );
    case 'ended':
      return active.filter((tool) => tool.runId !== event.runId);
    default:
      return active;
  }
  return previous ? active.map((tool) => (matches(tool) ? next : tool)) : [...active, next];
}

export function latestToolActivity(
  active: ToolActivity[],
  runId: RunId | null,
  turnId: string | null,
): ToolActivity | undefined {
  let latest: ToolActivity | undefined;
  for (const tool of active) {
    if (
      tool.runId === runId &&
      tool.turnId === turnId &&
      (!latest ||
        (tool.previewOrder !== undefined && latest.previewOrder === undefined) ||
        (tool.previewOrder !== undefined &&
          latest.previewOrder !== undefined &&
          tool.previewOrder > latest.previewOrder) ||
        (tool.previewOrder === undefined &&
          latest.previewOrder === undefined &&
          tool.startSequence > latest.startSequence))
    )
      latest = tool;
  }
  return latest;
}

export function toolActivitySummary(
  tool: ToolActivity,
  phaseLabel: string,
  title?: string,
): string {
  // A model's streamed input is raw arguments; only an executor's progress reads as text.
  const detail = tool.source === 'executor' ? tool.detail.replace(/\s+/g, ' ').trim() : '';
  return [phaseLabel, title === phaseLabel ? '' : (title ?? tool.name), detail]
    .filter(Boolean)
    .join(' · ');
}
