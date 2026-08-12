import { classifyToolUse } from '@maka/core/permission';
import type { CollaborationMode } from '@maka/core/collaboration';
import type { PlanExecution, PlanProposal } from '@maka/core/plan';

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

export function renderInterruptedPlanContext(input: {
  proposal: PlanProposal;
  execution: PlanExecution;
  fullAccess?: boolean;
}): string {
  const steps = input.execution.steps.map((step) => renderExecutionStep(step)).join('\n');
  return [
    '<interrupted_plan_context>',
    `Plan: ${input.proposal.title}`,
    `Plan ID: ${input.proposal.planId}`,
    `Proposal: ${input.proposal.proposalId} (revision ${input.proposal.revision})`,
    `Interrupted execution ID: ${input.execution.executionId}`,
    input.execution.interruptionReason
      ? `Interruption reason: ${input.execution.interruptionReason}`
      : '',
    'Progress at interruption:',
    steps,
    input.fullAccess
      ? 'The user entered Plan Mode to replan the remaining work. Do not resume the interrupted execution automatically. Full access remains active; modify files or perform side effects only when the user explicitly requests them during replanning. A submitted proposal will supersede this interrupted execution when approved.'
      : 'The user entered Plan Mode to replan the remaining work. Do not resume execution or modify files. A submitted proposal will supersede this interrupted execution when approved.',
    '</interrupted_plan_context>',
  ]
    .filter(Boolean)
    .join('\n');
}

export function renderPlanExecutionPrompt(input: {
  proposal: PlanProposal;
  execution: PlanExecution;
}): string {
  const steps = input.execution.steps.map((step) => renderExecutionStep(step)).join('\n');
  return [
    '<plan_execution_context>',
    `Plan: ${input.proposal.title}`,
    `Plan ID: ${input.proposal.planId}`,
    `Proposal: ${input.proposal.proposalId} (revision ${input.proposal.revision})`,
    `Execution ID: ${input.execution.executionId}`,
    input.proposal.overview ? `Overview: ${input.proposal.overview}` : '',
    'Approved steps:',
    steps,
    'Execute this approved plan. Before implementation, call update_plan with the first actionable step in_progress and every other step at its current status. Immediately after finishing a step, call update_plan again to mark it completed and move the next step to in_progress. Before the final response, update every finished or skipped step so the execution can close. If the user explicitly abandons the plan, call cancel_plan. Do not delegate to subagents while this execution is active.',
    '</plan_execution_context>',
  ]
    .filter(Boolean)
    .join('\n');
}

function statusMark(status: PlanExecution['steps'][number]['status']): string {
  if (status === 'completed') return 'x';
  if (status === 'in_progress') return '>';
  if (status === 'skipped') return '-';
  return ' ';
}

function renderExecutionStep(step: PlanExecution['steps'][number]): string {
  return [
    '<step>',
    `<id>${escapeXml(step.id)}</id>`,
    `<title>${escapeXml(step.title)}</title>`,
    `<description>${escapeXml(step.description)}</description>`,
    `<status>${step.status}</status>`,
    '</step>',
  ].join('\n');
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}
