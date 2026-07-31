import { z } from 'zod';
import type {
  PlanExecution,
  PlanMutationResult,
  PlanProposal,
  PlanStepStatus,
  PlanStore,
} from '@maka/core/plan';

import type { MakaTool } from './tool-runtime.js';

const MARKDOWN_PATTERN =
  /(^|\n)\s{0,3}(?:#{1,6}\s|[-*+]\s|\d+[.)]\s|>\s|```|~~~)|!?(?:\[[^\]\n]+\]\([^)\n]+\))|(?:\*\*|__|`)/;

const plainTextSchema = (label: string) =>
  z
    .string()
    .trim()
    .min(1)
    .refine((value) => !MARKDOWN_PATTERN.test(value), {
      message: `${label} must be plain text without Markdown formatting`,
    });

const stepDefinitionSchema = z.object({
  id: z.string().trim().min(1),
  title: plainTextSchema('Plan step title').max(30),
  description: plainTextSchema('Plan step description'),
  files: z.array(z.string().min(1)).optional(),
  complexity: z.enum(['low', 'medium', 'high']).optional(),
});

const executionStepSchema = z.object({
  id: z.string().min(1),
  status: z.enum(['pending', 'in_progress', 'completed', 'skipped']),
  note: z.string().min(1).optional(),
});

export type PlanToolResult =
  | {
      kind: 'plan_submitted';
      proposal: PlanProposal;
      storeVersion: number;
    }
  | {
      kind: 'plan_progress_updated' | 'plan_execution_completed';
      execution: PlanExecution;
      storeVersion: number;
    }
  | {
      kind: 'plan_execution_cancelled';
      execution: PlanExecution;
      storeVersion: number;
    };

export function buildSubmitPlanTool(
  planStore: PlanStore,
  sourceExecutionId?: string,
): MakaTool<
  {
    title: string;
    overview?: string;
    steps: Array<{
      id: string;
      title: string;
      description: string;
      files?: string[];
      complexity?: 'low' | 'medium' | 'high';
    }>;
    risks?: string[];
  },
  PlanToolResult
> {
  return {
    name: 'SubmitPlan',
    description:
      'Submit the finished implementation plan for user approval. Every step requires a concise plain-text title and a detailed plain-text description; do not use Markdown in either field. This ends the planning turn, so do not call it until the plan is ready to review.',
    parameters: z.object({
      title: z.string().min(1),
      overview: z.string().min(1).optional(),
      steps: z.array(stepDefinitionSchema).min(1).max(50),
      risks: z.array(z.string().min(1)).max(20).optional(),
    }),
    impl: async (input, context) => {
      const result = await planStore.submitProposal({
        sessionId: context.sessionId,
        turnId: context.turnId,
        ...(sourceExecutionId ? { sourceExecutionId } : {}),
        ...input,
      });
      return {
        kind: 'plan_submitted',
        proposal: result.state.proposals.find(
          (proposal) => proposal.proposalId === result.state.latestProposalId,
        )!,
        storeVersion: result.state.storeVersion,
      };
    },
  };
}

export function buildUpdatePlanTool(
  planStore: PlanStore,
  executionId: string,
): MakaTool<
  {
    steps: Array<{ id: string; status: PlanStepStatus; note?: string }>;
    explanation?: string;
  },
  PlanToolResult
> {
  return {
    name: 'update_plan',
    description:
      'Update execution progress for the approved plan. Include every plan step and keep at most one step in_progress.',
    parameters: z.object({
      steps: z.array(executionStepSchema).min(1).max(50),
      explanation: z.string().min(1).optional(),
    }),
    impl: async (input, context) => {
      const result = await planStore.updateExecution({
        sessionId: context.sessionId,
        executionId,
        ...input,
      });
      return executionResult(result);
    },
  };
}

export function buildCancelPlanTool(
  planStore: PlanStore,
  executionId: string,
): MakaTool<{ reason: string }, PlanToolResult> {
  return {
    name: 'cancel_plan',
    description:
      'Cancel the active plan execution when the user explicitly asks to abandon it. Explain the user request in reason.',
    parameters: z.object({ reason: z.string().min(1) }),
    impl: async ({ reason }, context) => {
      const result = await planStore.cancelExecution({
        sessionId: context.sessionId,
        executionId,
        reason,
      });
      return executionResult(result);
    },
  };
}

function executionResult(result: PlanMutationResult): PlanToolResult {
  const executionId =
    'executionId' in result.event ? result.event.executionId : result.state.activeExecutionId;
  const execution = result.state.executions.find(
    (candidate) => candidate.executionId === executionId,
  );
  if (!execution) throw new Error('Plan execution projection is missing');
  if (result.event.type === 'plan_execution_completed') {
    return { kind: 'plan_execution_completed', execution, storeVersion: result.state.storeVersion };
  }
  if (result.event.type === 'plan_execution_cancelled') {
    return { kind: 'plan_execution_cancelled', execution, storeVersion: result.state.storeVersion };
  }
  return { kind: 'plan_progress_updated', execution, storeVersion: result.state.storeVersion };
}
