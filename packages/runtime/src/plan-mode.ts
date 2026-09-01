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

import { classifyToolUse } from '@maka/core/permission';
import type { CollaborationMode } from '@maka/core/collaboration';

import type { MakaTool } from './tool-runtime.js';

const PLAN_CONTROL_TOOLS = new Set(['SubmitPlan', 'update_plan', 'cancel_plan']);
const PLAN_AUTONOMOUS_WORKFLOW_TOOLS = new Set([
  'ScheduledTask',
  'GoalSet',
  'GoalClear',
  'GoalStatus',
  'GoalPause',
  'GoalResume',
  'update_agent_graph',
  'yield_agent_graph',
]);

export function selectCollaborationTools(input: {
  mode: CollaborationMode;
  tools: readonly MakaTool[];
  hasActiveExecution: boolean;
  fullAccess?: boolean;
}): MakaTool[] {
  if (input.mode === 'plan') {
    return input.tools.filter((tool) => {
      if (tool.name === 'SubmitPlan' || tool.name === 'AskUserQuestion') return true;
      if (PLAN_CONTROL_TOOLS.has(tool.name)) return false;
      const category = classifyToolUse({
        toolName: tool.name,
        args: {},
        ...(tool.categoryHint ? { categoryHint: tool.categoryHint } : {}),
      });
      if (input.fullAccess) {
        return category !== 'subagent' && !PLAN_AUTONOMOUS_WORKFLOW_TOOLS.has(tool.name);
      }
      return category === 'read' || category === 'web_read';
    });
  }

  return input.tools.filter((tool) => {
    if (tool.name === 'SubmitPlan') return false;
    if (tool.categoryHint === 'subagent' && input.hasActiveExecution) return false;
    if (tool.name === 'update_plan' || tool.name === 'cancel_plan') {
      return input.hasActiveExecution;
    }
    return true;
  });
}

export function renderPlanModePrompt(input: { fullAccess?: boolean } = {}): string {
  if (input.fullAccess) {
    return [
      '<collaboration_mode>',
      '# Collaboration Mode: Plan',
      'You are planning. Inspect the repository, discuss tradeoffs, and prepare a concrete plan for approval.',
      'Full access is active. Do not impose Plan Mode read-only restrictions; mutating tools are available when the user explicitly requests side effects during planning.',
      'Full access does not approve implementation by itself. Keep the planning workflow active until the user approves a submitted plan or explicitly asks you to act now.',
      'Use AskUserQuestion only when a bounded answer is required. Subagents and scheduled tasks are unavailable in this mode.',
      'When the plan is ready for approval, call SubmitPlan exactly once with a concise title, overview, ordered steps, and material risks.',
      'Every step must have a short title (30 characters or fewer) and a detailed description. Both fields must be plain text without Markdown formatting.',
      'Do not claim that implementation has started or completed unless the user explicitly asked for those side effects.',
      '</collaboration_mode>',
    ].join('\n');
  }
  return [
    '<collaboration_mode>',
    '# Collaboration Mode: Plan',
    'You are planning only. Inspect the repository and discuss tradeoffs, but do not modify files or perform side effects.',
    'Use AskUserQuestion only when a bounded answer is required. Subagents are unavailable in this mode.',
    'When the plan is ready for approval, call SubmitPlan exactly once with a concise title, overview, ordered steps, and material risks.',
    'Every step must have a short title (30 characters or fewer) and a detailed description. Both fields must be plain text without Markdown formatting.',
    'Do not claim that implementation has started or completed.',
    '</collaboration_mode>',
  ].join('\n');
}
