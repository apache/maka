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

import assert from 'node:assert/strict';

type ScenarioPhase =
  | 'initial_root'
  | 'await_add_work_result'
  | 'await_checkpoint'
  | 'await_view_result'
  | 'await_agent_output'
  | 'await_finish_result'
  | 'completed';

export interface AgentGraphProviderReply {
  text(text: string): void;
  toolCall(toolName: string, args: Record<string, unknown>): void;
}

export class AgentGraphProviderScenario {
  #phase: ScenarioPhase = 'initial_root';
  #childCompleted = false;
  #resultRecordId: string | undefined;

  constructor(private readonly childResultText: string) {}

  respond(body: Record<string, unknown>, reply: AgentGraphProviderReply): void {
    const names = toolNames(body);
    // The graph child's exact surface: its read-only allowlist plus the archive
    // decoder every session that archives now carries (#2026).
    if (names.join(',') === 'ArchiveRead,Glob,Grep,Read') {
      assert.equal(this.#childCompleted, false, 'Graph child provider request was repeated');
      this.#childCompleted = true;
      reply.text(this.childResultText);
      return;
    }
    for (const required of [
      'agent_output',
      'update_agent_graph',
      'view_agent_graph',
      'yield_agent_graph',
    ]) {
      assert.ok(names.includes(required), `Graph provider request omitted ${required}`);
    }

    const toolResult = latestToolResultAfterCurrentUser(body);
    switch (this.#phase) {
      case 'initial_root':
        assert.equal(toolResult, undefined);
        this.#phase = 'await_add_work_result';
        reply.toolCall('update_agent_graph', {
          operation: 'add_work',
          add_work: [
            {
              target_kind: 'new_agent',
              agent_id: 'local-read',
              instruction: 'Inspect the hosted Graph execution boundary.',
              input_ids: [],
              replacement_mode: 'none',
            },
          ],
        });
        return;
      case 'await_add_work_result': {
        const updated = requireRecord(toolResult, 'add-work result');
        assert.equal(updated.kind, 'agent_graph_updated');
        assert.equal(requireRecord(updated.schedule, 'add-work schedule').closed, false);
        this.#phase = 'await_checkpoint';
        reply.toolCall('yield_agent_graph', {
          reason: 'Wait for the hosted operator checkpoint.',
        });
        return;
      }
      case 'await_checkpoint':
        assert.equal(toolResult, undefined);
        assert.match(latestUserText(body), /reached a durable supervisor checkpoint\./);
        this.#phase = 'await_view_result';
        reply.toolCall('view_agent_graph', { mode: 'latest' });
        return;
      case 'await_view_result': {
        const view = requireRecord(toolResult, 'graph view result');
        assert.equal(view.kind, 'agent_graph_view');
        const operators = requireArray(
          requireRecord(view.runtime, 'graph view runtime').operators,
          'graph view operators',
        );
        assert.ok(operators.length <= 1);
        if (operators.length === 0) {
          this.#phase = 'await_checkpoint';
          reply.toolCall('yield_agent_graph', {
            reason: 'The hosted operator has not started yet.',
          });
          return;
        }
        const operator = requireRecord(operators[0], 'graph view operator');
        if (operator.status !== 'completed') {
          assert.ok(
            ['not_started', 'waiting', 'runnable', 'running', 'blocked'].includes(
              requireString(operator.status, 'Graph operator status'),
            ),
          );
          this.#phase = 'await_checkpoint';
          reply.toolCall('yield_agent_graph', {
            reason: 'The hosted operator is still running.',
          });
          return;
        }
        const childSessionId = requireString(operator.childSessionId, 'child Session id');
        const runId = requireString(operator.currentRunId, 'child Run id');
        assert.equal(this.#childCompleted, true);
        this.#phase = 'await_agent_output';
        reply.toolCall('agent_output', {
          locator: 'child_session_run',
          child_session_id: childSessionId,
          run_id: runId,
          view: 'result',
          max_bytes: 32_768,
        });
        return;
      }
      case 'await_agent_output': {
        const output = requireRecord(toolResult, 'agent output result');
        assert.equal(
          requireRecord(output.execution, 'agent output execution').kind,
          'child_session',
        );
        assert.equal(requireRecord(output.header, 'agent output header').status, 'completed');
        const result = requireRecord(output.result, 'agent output payload');
        assert.equal(result.status, 'completed');
        assert.equal(result.text, this.childResultText);
        this.#resultRecordId = requireString(result.resultRecordId, 'Graph result record id');
        this.#phase = 'await_finish_result';
        reply.toolCall('update_agent_graph', {
          operation: 'finish',
          finish: {
            result_ids: [this.#resultRecordId],
            reason: 'The hosted graph result is committed.',
          },
        });
        return;
      }
      case 'await_finish_result': {
        const updated = requireRecord(toolResult, 'finish result');
        assert.equal(updated.kind, 'agent_graph_updated');
        const schedule = requireRecord(updated.schedule, 'finished graph schedule');
        assert.equal(schedule.closed, true);
        assert.deepEqual(requireRecord(schedule.finish, 'graph finish').resultIds, [
          this.#resultRecordId,
        ]);
        this.#phase = 'completed';
        reply.text('Hosted Agent Graph execution completed.');
        return;
      }
      case 'completed':
        assert.fail('Graph provider scenario received a request after completion');
    }
  }
}

function toolNames(body: Record<string, unknown>): string[] {
  const tools = Array.isArray(body.tools) ? body.tools : [];
  return tools
    .map((tool) => {
      if (!tool || typeof tool !== 'object') return undefined;
      const fn = (tool as { function?: unknown }).function;
      if (!fn || typeof fn !== 'object') return undefined;
      const name = (fn as { name?: unknown }).name;
      return typeof name === 'string' ? name : undefined;
    })
    .filter((name): name is string => name !== undefined)
    .sort();
}

function latestUserText(body: Record<string, unknown>): string {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || typeof message !== 'object') continue;
    const record = message as { role?: unknown; content?: unknown };
    if (record.role === 'user') return requireString(record.content, 'latest UserMessage');
  }
  assert.fail('Graph provider request has no UserMessage');
}

function latestToolResultAfterCurrentUser(body: Record<string, unknown>): unknown {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  let currentUserIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message && typeof message === 'object' && (message as { role?: unknown }).role === 'user') {
      currentUserIndex = index;
      break;
    }
  }
  for (let index = messages.length - 1; index > currentUserIndex; index -= 1) {
    const message = messages[index];
    if (!message || typeof message !== 'object') continue;
    const record = message as { role?: unknown; content?: unknown };
    if (record.role !== 'tool') continue;
    if (typeof record.content !== 'string') throw new Error('Tool result content is not a string');
    return JSON.parse(record.content) as unknown;
  }
  return undefined;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  assert.ok(
    value && typeof value === 'object' && !Array.isArray(value),
    `${label} is not an object`,
  );
  return value as Record<string, unknown>;
}

function requireArray(value: unknown, label: string): unknown[] {
  assert.ok(Array.isArray(value), `${label} is not an array`);
  return value;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label} is not a string`);
  return value;
}
