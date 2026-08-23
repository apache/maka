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

import { createHash } from 'node:crypto';
import { z } from 'zod';
import type {
  PlanExecution,
  PlanMutationResult,
  PlanProposal,
  PlanStepStatus,
  PlanStore,
} from '@maka/core/plan';
import {
  PLAN_MAX_FILES_PER_STEP,
  PLAN_MAX_RISKS,
  PLAN_MAX_STEPS,
  PLAN_LIFECYCLE_REASON_MAX_BYTES,
  PLAN_STEP_TITLE_MAX_CHARS,
  isCanonicalPlanEntityId,
  isPlanProposalLifecycleAdmissible,
  isPlanTextWithinLimit,
} from '@maka/core/plan';

import type { MakaTool } from './tool-runtime.js';

const MARKDOWN_PATTERN =
  /(^|\n)\s{0,3}(?:#{1,6}\s|[-*+]\s|\d+[.)]\s|>\s|```|~~~)|!?(?:\[[^\]\n]+\]\([^)\n]+\))|(?:\*\*|__|`)/;

const boundedTextSchema = (label: string, maxBytes?: number) =>
  z
    .string()
    .trim()
    .min(1)
    .refine((value) => isPlanTextWithinLimit(value, maxBytes), {
      message: `${label} exceeds the Plan text limit`,
    });

const plainTextSchema = (label: string) =>
  z
    .string()
    .trim()
    .min(1)
    .refine(isPlanTextWithinLimit, { message: `${label} exceeds the Plan text limit` })
    .refine((value) => !MARKDOWN_PATTERN.test(value), {
      message: `${label} must be plain text without Markdown formatting`,
    });

const stepDefinitionSchema = z.object({
  id: z.string().trim().refine(isCanonicalPlanEntityId, {
    message: 'Plan step id must be a canonical entity id',
  }),
  title: plainTextSchema('Plan step title').max(PLAN_STEP_TITLE_MAX_CHARS),
  description: plainTextSchema('Plan step description'),
  files: z.array(boundedTextSchema('Plan step file')).max(PLAN_MAX_FILES_PER_STEP).optional(),
  complexity: z.enum(['low', 'medium', 'high']).optional(),
});

const executionStepSchema = z.object({
  id: z.string().refine(isCanonicalPlanEntityId, {
    message: 'Plan step id must be a canonical entity id',
  }),
  status: z.enum(['pending', 'in_progress', 'completed', 'skipped']),
  note: boundedTextSchema('Plan step note').optional(),
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
    parameters: z
      .object({
        title: boundedTextSchema('Plan title'),
        overview: boundedTextSchema('Plan overview').optional(),
        steps: z.array(stepDefinitionSchema).min(1).max(PLAN_MAX_STEPS),
        risks: z.array(boundedTextSchema('Plan risk')).max(PLAN_MAX_RISKS).optional(),
      })
      .refine(
        isPlanProposalLifecycleAdmissible,
        'Plan proposal cannot fit its execution lifecycle projection',
      ),
    recoveryMode: 'idempotent',
    nesting: 'direct_only',
    impl: async (input, context) => {
      const result = await planStore.submitProposal({
        operationId: planToolOperationId('submit', context),
        sessionId: context.sessionId,
        turnId: context.turnId,
        ...(sourceExecutionId ? { sourceExecutionId } : {}),
        ...input,
      });
      return {
        kind: 'plan_submitted',
        proposal:
          result.event.type === 'plan_submitted'
            ? result.event.proposal
            : missingPlanToolProjection('SubmitPlan'),
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
      steps: z.array(executionStepSchema).min(1).max(PLAN_MAX_STEPS),
      explanation: boundedTextSchema('Plan progress explanation').optional(),
    }),
    recoveryMode: 'idempotent',
    nesting: 'direct_only',
    impl: async (input, context) => {
      const result = await planStore.updateExecution({
        operationId: planToolOperationId('update', context),
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
    parameters: z.object({
      reason: boundedTextSchema('Plan cancellation reason', PLAN_LIFECYCLE_REASON_MAX_BYTES),
    }),
    recoveryMode: 'idempotent',
    nesting: 'direct_only',
    impl: async ({ reason }, context) => {
      const result = await planStore.cancelExecution({
        operationId: planToolOperationId('cancel', context),
        sessionId: context.sessionId,
        executionId,
        reason,
      });
      return executionResult(result);
    },
  };
}

function planToolOperationId(
  kind: 'submit' | 'update' | 'cancel',
  context: { sessionId: string; turnId: string; toolCallId: string },
): string {
  return `plan_${createHash('sha256')
    .update(kind)
    .update('\0')
    .update(context.sessionId)
    .update('\0')
    .update(context.turnId)
    .update('\0')
    .update(context.toolCallId)
    .digest('hex')}`;
}

function missingPlanToolProjection(toolName: string): never {
  throw new Error(`${toolName} received an incompatible idempotent Plan result`);
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
