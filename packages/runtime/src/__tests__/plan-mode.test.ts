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

import type { PlanExecution, PlanExecutionStep, PlanProposal } from '@maka/core/plan';

import {
  renderPlanExecutionRequest,
  renderPlanModePrompt,
  selectCollaborationTools,
} from '../plan-mode.js';
import { buildCancelPlanTool, buildSubmitPlanTool, buildUpdatePlanTool } from '../plan-tools.js';
import type { MakaTool } from '../tool-runtime.js';

describe('Plan Mode tool surface', () => {
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

describe('Plan execution request', () => {
  test('approval carries every step id, title and status plus the progress instruction', () => {
    const request = renderPlanExecutionRequest({
      kind: 'approve_proposal',
      proposal: proposal(),
      execution: execution([
        step('inspect', 'Inspect the caller', 'pending'),
        step('patch', 'Land the fix', 'pending'),
      ]),
    });

    assert.match(request, /^Execute the approved plan execution execution-1\.\n/);
    assert.match(request, /^Plan: Ship the plan request \(revision 2\)$/m);
    assert.match(request, /^- inspect \[pending\] Inspect the caller$/m);
    assert.match(request, /^- patch \[pending\] Land the fix$/m);
    assert.match(request, /update_plan/);
    assert.match(request, /first actionable step in_progress/);
    assert.match(request, /cancel_plan/);
    assert.match(request, /Do not delegate to subagents while this execution is active\./);
    // Descriptions stay in the Plan proposal: the request stays bounded by the
    // step list, not by PLAN_TEXT_MAX_BYTES-sized prose.
    assert.doesNotMatch(request, /Read the relevant files\./);
  });

  test('resume reports the progress reached before the interruption', () => {
    const request = renderPlanExecutionRequest({
      kind: 'resume_execution',
      proposal: proposal(),
      execution: execution([
        step('inspect', 'Inspect the caller', 'completed'),
        step('patch', 'Land the fix', 'in_progress'),
      ]),
    });

    assert.match(request, /^Resume the approved plan execution execution-1\.\n/);
    assert.match(request, /^- inspect \[completed\] Inspect the caller$/m);
    assert.match(request, /^- patch \[in_progress\] Land the fix$/m);
    assert.match(request, /resuming in_progress/);
  });

  test('is a pure function of the execution it is given', () => {
    const input = {
      kind: 'approve_proposal' as const,
      proposal: proposal(),
      execution: execution([
        step('inspect', 'Inspect the caller', 'completed'),
        step('patch', 'Land the fix', 'in_progress'),
      ]),
    };

    // The request is persisted as the Turn's own user message, so a replay must
    // reproduce the same bytes rather than re-deriving them from live state.
    assert.equal(renderPlanExecutionRequest(input), renderPlanExecutionRequest(input));
  });
});

function proposal(): PlanProposal {
  const steps = [
    { id: 'inspect', title: 'Inspect the caller', description: 'Read the relevant files.' },
    { id: 'patch', title: 'Land the fix', description: 'Update the Host request.' },
  ];
  return {
    planId: 'plan-1',
    proposalId: 'proposal-1',
    sessionId: 'session-1',
    turnId: 'turn-1',
    revision: 2,
    title: 'Ship the plan request',
    steps,
    status: 'approved',
    submittedAt: 1,
  };
}

function execution(steps: PlanExecutionStep[]): PlanExecution {
  return {
    executionId: 'execution-1',
    planId: 'plan-1',
    proposalId: 'proposal-1',
    sessionId: 'session-1',
    status: 'active',
    steps,
    startedAt: 1,
    updatedAt: 2,
  };
}

function step(id: string, title: string, status: PlanExecutionStep['status']): PlanExecutionStep {
  return {
    id,
    title,
    description: 'Read the relevant files.',
    status,
    updatedAt: 2,
  };
}

function tool(name: string, categoryHint?: MakaTool['categoryHint']): MakaTool {
  return {
    name,
    description: name,
    parameters: {},
    ...(categoryHint ? { categoryHint } : {}),
    impl: () => null,
  };
}
