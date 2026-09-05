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
import { describe, test } from 'node:test';

import { renderPlanModePrompt, selectCollaborationTools } from '../plan-mode.js';
import { buildCancelPlanTool, buildSubmitPlanTool, buildUpdatePlanTool } from '../plan-tools.js';
import type { MakaTool } from '../tool-runtime.js';

describe('Plan Mode tool surface', () => {
  test('keeps plan lifecycle controls outside nested Code Mode execution', () => {
    const store = {} as never;

    assert.equal(buildSubmitPlanTool(store).nesting, 'direct_only');
    assert.equal(buildUpdatePlanTool(store, 'execution-1').nesting, 'direct_only');
    assert.equal(buildCancelPlanTool(store, 'execution-1').nesting, 'direct_only');
  });

  test('requires plain-text step titles and descriptions', () => {
    const submitPlan = buildSubmitPlanTool({} as never);
    assert.equal(submitPlan.recoveryMode, 'idempotent');
    const schema = submitPlan.parameters as {
      safeParse(input: unknown): { success: boolean };
    };
    const valid = {
      title: 'Plan',
      steps: [{ id: 'inspect', title: 'Inspect code', description: 'Read the relevant files.' }],
    };

    assert.equal(schema.safeParse(valid).success, true);
    assert.equal(
      schema.safeParse({ title: 'Plan', steps: [{ id: 'inspect', description: 'Read files.' }] })
        .success,
      false,
    );
    assert.equal(
      schema.safeParse({
        title: 'Plan',
        steps: [{ id: 'inspect', title: '**Inspect code**', description: 'Read files.' }],
      }).success,
      false,
    );
    assert.equal(
      schema.safeParse({
        title: 'Plan',
        steps: [{ id: 'inspect', title: 'Inspect code', description: '- Read files' }],
      }).success,
      false,
    );
    assert.equal(
      schema.safeParse({
        title: 'Plan',
        steps: [{ id: 'step one', title: 'Inspect code', description: 'Read files.' }],
      }).success,
      false,
    );
    assert.equal(
      schema.safeParse({
        title: 'Plan',
        steps: [
          {
            id: 'inspect',
            title: 'Inspect code',
            description: 'x'.repeat(16 * 1024 + 1),
          },
        ],
      }).success,
      false,
    );
    assert.equal(
      schema.safeParse({
        title: 'Plan',
        steps: Array.from({ length: 16 }, (_, index) => ({
          id: `step-${index}`,
          title: `Step ${index}`,
          description: 'x'.repeat(4_000),
        })),
      }).success,
      false,
    );
    const lifecycleSteps = (descriptionBytes: number) =>
      Array.from({ length: 50 }, (_, index) => ({
        id: `step-${index}`,
        title: `Step ${index}`,
        description: 'x'.repeat(descriptionBytes),
      }));
    assert.equal(schema.safeParse({ title: 'Plan', steps: lifecycleSteps(900) }).success, true);
    assert.equal(schema.safeParse({ title: 'Plan', steps: lifecycleSteps(1_100) }).success, false);
    assert.match(renderPlanModePrompt(), /plain text without Markdown formatting/);
  });

  test('keeps read tools and plan controls while removing writes and subagents', () => {
    const selected = selectCollaborationTools({
      mode: 'plan',
      hasActiveExecution: false,
      tools: [
        tool('Read', 'read'),
        tool('WebSearch', 'web_read'),
        tool('Write', 'file_write'),
        tool('agent_spawn', 'subagent'),
        tool('AskUserQuestion'),
        tool('SubmitPlan'),
        tool('update_plan'),
      ],
    });
    assert.deepEqual(
      selected.map((tool) => tool.name),
      ['Read', 'WebSearch', 'AskUserQuestion', 'SubmitPlan'],
    );
  });

  test('restores mutating tools for full access without enabling autonomous workflows', () => {
    const selected = selectCollaborationTools({
      mode: 'plan',
      hasActiveExecution: false,
      fullAccess: true,
      tools: [
        tool('Read', 'read'),
        tool('Write', 'file_write'),
        tool('Bash', 'shell_unsafe'),
        tool('Browser', 'browser'),
        tool('CustomTool'),
        tool('ScheduledTask'),
        tool('GoalSet'),
        tool('agent_spawn', 'subagent'),
        tool('AskUserQuestion'),
        tool('SubmitPlan'),
        tool('update_plan'),
      ],
    });
    assert.deepEqual(
      selected.map((tool) => tool.name),
      ['Read', 'Write', 'Bash', 'Browser', 'CustomTool', 'AskUserQuestion', 'SubmitPlan'],
    );

    const prompt = renderPlanModePrompt({ fullAccess: true });
    assert.match(prompt, /Full access is active/);
    assert.doesNotMatch(prompt, /do not modify files/);
    assert.match(prompt, /planning workflow active/);
  });

  test('active execution exposes progress controls and removes subagents', () => {
    const selected = selectCollaborationTools({
      mode: 'agent',
      hasActiveExecution: true,
      tools: [
        tool('Write', 'file_write'),
        tool('agent_spawn', 'subagent'),
        tool('SubmitPlan'),
        tool('update_plan'),
        tool('cancel_plan'),
      ],
    });
    assert.deepEqual(
      selected.map((tool) => tool.name),
      ['Write', 'update_plan', 'cancel_plan'],
    );
  });
});

function tool(name: string, categoryHint?: MakaTool['categoryHint']): MakaTool {
  return {
    name,
    description: name,
    parameters: {},
    ...(categoryHint ? { categoryHint } : {}),
    impl: () => null,
  };
}
