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
import type { DisplayText } from '../../../../packages/plugin-sdk/src/index.js';

// Display-only source observations. No preview is parsed or used to authorize a tool.
export type ToolActivity = {
  invocationId: string;
  turnId: string;
  toolUseId: string;
  stepId?: string;
  startSequence: number;
  name: string;
  title?: DisplayText;
  source: 'native' | 'provider' | 'executor';
  phase: 'preparing' | 'running';
  inputReady: boolean;
  detail: string;
};
type Delivery = {
  invocationId: string;
  turnId: string;
  sequence: number;
  fact: any;
};

function snippet(text: string): string {
  // A UTF-16 suffix is at most twice the retained codepoint budget. Taking the
  // final codepoints also drops a possible leading half-surrogate from slicing.
  return Array.from(text.slice(-4096)).slice(-2048).join('');
}

export function updateToolActivity(active: ToolActivity[], event: Delivery): ToolActivity[] {
  const fact = event.fact;
  const matches = (tool: ToolActivity) =>
    tool.invocationId === event.invocationId && tool.toolUseId === fact.toolUseId;
  const previous = active.find(matches);
  const start = (source: ToolActivity['source'], phase: ToolActivity['phase']): ToolActivity => ({
    invocationId: event.invocationId,
    turnId: event.turnId,
    toolUseId: fact.toolUseId,
    stepId: fact.stepId,
    startSequence: event.sequence,
    name: snippet(fact.name),
    source,
    phase,
    inputReady: false,
    detail: '',
  });
  let next: ToolActivity;
  switch (fact.kind) {
    case 'tool_input_started':
      next = previous ?? start(fact.providerExecuted ? 'provider' : 'native', 'preparing');
      break;
    case 'tool_input_delta':
      if (!previous || previous.phase !== 'preparing') return active;
      next = { ...previous, detail: snippet(previous.detail + fact.text) };
      break;
    case 'tool_input_ready':
      next = {
        ...(previous ?? start(fact.providerExecuted ? 'provider' : 'native', 'preparing')),
        stepId: fact.stepId,
        name: snippet(fact.name),
        source: fact.providerExecuted ? 'provider' : 'native',
        inputReady: true,
        phase: fact.providerExecuted ? 'running' : 'preparing',
      };
      break;
    case 'tool_dispatched':
      next = {
        ...(previous ?? start('native', 'running')),
        source: 'native',
        phase: 'running',
        name: snippet(fact.name),
        title: fact.title,
      };
      break;
    case 'executor_tool_start':
      next = {
        ...(previous ?? start('executor', 'running')),
        source: 'executor',
        phase: 'running',
        stepId: event.invocationId,
        name: snippet(fact.name),
        inputReady: true,
      };
      break;
    case 'executor_tool_progress':
      if (!previous || previous.source !== 'executor') return active;
      next = { ...previous, detail: snippet(fact.text) };
      break;
    case 'tool_rejected':
    case 'tool_settled':
    case 'provider_tool_result':
    case 'executor_tool_result':
      return previous ? active.filter((tool) => !matches(tool)) : active;
    case 'step_ended':
      return active.filter(
        (tool) =>
          tool.invocationId !== event.invocationId ||
          tool.stepId !== fact.stepId ||
          (tool.source === 'native' &&
            (tool.phase === 'running' || (fact.completed && tool.inputReady))),
      );
    case 'ended':
      return active.filter((tool) => tool.invocationId !== event.invocationId);
    default:
      return active;
  }
  return previous ? active.map((tool) => (matches(tool) ? next : tool)) : [...active, next];
}

export function latestToolActivity(
  active: ToolActivity[],
  invocationId: string | null,
  turnId: string,
): ToolActivity | undefined {
  let latest: ToolActivity | undefined;
  for (const tool of active) {
    if (
      tool.invocationId === invocationId &&
      tool.turnId === turnId &&
      (!latest || tool.startSequence > latest.startSequence)
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
  const detail = tool.detail.replace(/\s+/g, ' ').trim();
  return [phaseLabel, tool.name, title ? snippet(title) : undefined, detail]
    .filter(Boolean)
    .join(' · ');
}
