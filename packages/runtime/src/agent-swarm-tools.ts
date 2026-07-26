import { redactSecrets } from '@maka/core/redaction';
import {
  TASK_ID_MAX_CHARS,
  isSafeTaskId,
  projectAgentSwarmResult,
  type ToolResultContent,
} from '@maka/core';
import { z } from 'zod';
import {
  AGENT_WORKSPACE_SAME_WORKSPACE,
  AGENT_WORKSPACE_WORKTREE,
  AGENT_WRITE_BACK_PATCH,
  AGENT_WRITE_BACK_SUMMARY,
  BUILTIN_AGENT_PROFILES,
  requireBuiltinAgentDefinitionByProfile,
  type AgentDefinition,
} from './agent-catalog.js';
import {
  runAdaptiveSwarm,
  type AdaptiveSwarmPolicy,
  type AdaptiveSwarmItemResult,
} from './adaptive-swarm.js';
import type { SpawnChildAgentResult } from './session-manager.js';
import type { SubagentExecutionRef } from './subagent-execution.js';
import type { MakaTool, MakaToolContext } from './tool-runtime.js';

export const AGENT_SWARM_TOOL_NAME = 'agent_swarm';
export const AGENT_SWARM_DEFAULT_CONCURRENCY = 3;
export const AGENT_SWARM_MAX_CONCURRENCY = 5;
export const AGENT_SWARM_MAX_ITEMS = 32;
export const AGENT_SWARM_PROMPT_TEMPLATE_PLACEHOLDER = '{{item}}';
export const AGENT_SWARM_DEFAULT_ITEM_TIMEOUT_MS = 2 * 60 * 60 * 1_000;

const AGENT_SWARM_WRITE_BACK_MODES = [AGENT_WRITE_BACK_SUMMARY, AGENT_WRITE_BACK_PATCH] as const;
const AGENT_SWARM_ISOLATION_MODES = [
  AGENT_WORKSPACE_SAME_WORKSPACE,
  AGENT_WORKSPACE_WORKTREE,
] as const;
const AGENT_SWARM_TASK_MAX_CHARS = 60_000;
const AGENT_SWARM_ERROR_MAX_CHARS = 1_000;

export interface AgentSwarmExplicitItemInput {
  item_id: string;
  profile: string;
  task: string;
  write_back?: string;
  isolation?: string;
}

export interface AgentSwarmExplicitToolInput {
  items: AgentSwarmExplicitItemInput[];
  resume_run_ids?: Record<string, string>;
  max_concurrency?: number;
}

export interface AgentSwarmTemplateToolInput {
  prompt_template: string;
  profile: string;
  items: string[];
  resume_run_ids?: Record<string, string>;
  max_concurrency?: number;
}

export interface AgentSwarmResumeToolInput {
  resume_run_ids: Record<string, string>;
  max_concurrency?: number;
}

export type AgentSwarmToolInput =
  | AgentSwarmExplicitToolInput
  | AgentSwarmTemplateToolInput
  | AgentSwarmResumeToolInput;

export type AgentSwarmToolResult = Extract<ToolResultContent, { kind: 'agent_swarm' }>;

interface PreparedAgentSwarmItem {
  readonly index: number;
  readonly itemId: string;
  readonly profile: string;
  readonly task: string;
  readonly definition: AgentDefinition;
  readonly mode: 'spawn' | 'resume';
  readonly resumedFromRunId?: string;
  readonly execution?: SubagentExecutionRef;
}

interface PendingAgentSwarmResume {
  readonly index: number;
  readonly itemId: string;
  readonly sourceRunId: string;
  readonly task: string;
}

interface StartedChildRef {
  readonly childSessionId?: string;
  readonly turnId: string;
  readonly runId?: string;
  readonly agentId: string;
  readonly agentName: string;
}

type ChildExecutionResult = SpawnChildAgentResult & {
  readonly childSessionId?: string;
};

export function buildAgentSwarmTool(
  deps: {
    now?: () => number;
    adaptiveSwarmPolicy?: AdaptiveSwarmPolicy;
    itemTimeoutMs?: number;
  } = {},
): MakaTool<AgentSwarmToolInput, AgentSwarmToolResult> {
  const now = deps.now ?? Date.now;
  const itemTimeoutMs = normalizeItemTimeoutMs(
    deps.itemTimeoutMs ?? AGENT_SWARM_DEFAULT_ITEM_TIMEOUT_MS,
  );
  return {
    name: AGENT_SWARM_TOOL_NAME,
    displayName: 'Agent Swarm',
    description: [
      'Run the same kind of bounded foreground child work over several independent items.',
      `Provide either explicit structured items, or prompt_template with one shared profile and string items; every ${AGENT_SWARM_PROMPT_TEMPLATE_PLACEHOLDER} occurrence is replaced with the item value.`,
      'Use resume_run_ids to continue terminal child AgentRuns by runId; resumed children are ordered before new items.',
      'Use this only when every item can run independently. Results return in input order; you remain responsible for semantic synthesis.',
    ].join(' '),
    parameters: agentSwarmInputSchema(),
    permissionRequired: true,
    executionSemantics: 'exclusive_step',
    categoryHint: 'subagent',
    impl: async (input, ctx) => {
      const prepared = await prepareAgentSwarmInput(input, ctx);
      if (prepared.items.some((item) => item.mode === 'spawn') && !ctx.spawnChildSession) {
        throw new Error('spawnChildSession capability is unavailable in this runtime context');
      }
      if (
        prepared.items.some((item) => item.mode === 'resume') &&
        (!ctx.prepareChildAgentResume || !ctx.resumeChildAgent)
      ) {
        throw new Error('Child AgentRun resume capability is unavailable in this runtime context');
      }

      const startedAt = now();
      traceAgentSwarm(ctx, 'tool_started', 'batch_started', {
        itemCount: prepared.items.length,
        resumedItemCount: prepared.items.filter((item) => item.mode === 'resume').length,
        maxConcurrency: prepared.maxConcurrency,
      });
      for (
        let index = Math.min(prepared.maxConcurrency, prepared.items.length);
        index < prepared.items.length;
        index += 1
      ) {
        const item = prepared.items[index]!;
        traceAgentSwarm(ctx, 'tool_started', 'item_queued', {
          itemId: item.itemId,
          index: item.index,
          profile: item.profile,
          mode: item.mode,
          ...(item.resumedFromRunId ? { resumedFromRunId: item.resumedFromRunId } : {}),
          boundary: 'local_swarm_concurrency',
        });
      }
      const readyRefs: Array<StartedChildRef | undefined> = Array.from({
        length: prepared.items.length,
      });
      const childResults: Array<ChildExecutionResult | undefined> = Array.from({
        length: prepared.items.length,
      });
      const artifactIds = prepared.items.map(() => new Set<string>());
      const rows = await runAdaptiveSwarm<
        PreparedAgentSwarmItem,
        ChildExecutionResult,
        { sourceRunId: string; execution?: SubagentExecutionRef }
      >(
        prepared.items,
        async (item, { index, attempt, retry, markReady }) => {
          const deadline = createItemDeadline(ctx.abortSignal, itemTimeoutMs);
          traceAgentSwarm(ctx, 'tool_started', 'item_started', {
            itemId: item.itemId,
            index: item.index,
            profile: item.profile,
            mode: item.mode,
            ...(item.resumedFromRunId ? { resumedFromRunId: item.resumedFromRunId } : {}),
            attempt,
            retry: retry !== undefined,
            boundary: 'local_swarm_concurrency',
          });
          ctx.emitOutput(
            'stdout',
            `Agent swarm item ${item.itemId} ${retry ? 'retry' : 'started'}: ${item.definition.name}\n`,
          );
          try {
            const onReady = ({
              childSessionId,
              turnId,
              runId,
              agentId,
              agentName,
            }: StartedChildRef) => {
              readyRefs[index] = {
                ...(childSessionId ? { childSessionId } : {}),
                turnId,
                ...(runId ? { runId } : {}),
                agentId,
                agentName,
              };
              markReady();
            };
            const result: ChildExecutionResult = retry
              ? ctx.retryChildAgent
                ? ((await ctx.retryChildAgent({
                    sourceRunId: retry.sourceRunId,
                    ...(retry.execution ? { execution: retry.execution } : {}),
                    abortSignal: deadline.signal,
                    onReady,
                  })) as SpawnChildAgentResult)
                : (() => {
                    throw new Error('retryChildAgent capability is unavailable');
                  })()
              : item.mode === 'resume'
                ? ((await ctx.resumeChildAgent!({
                    sourceRunId: item.resumedFromRunId!,
                    prompt: item.task,
                    abortSignal: deadline.signal,
                    onReady,
                  })) as SpawnChildAgentResult)
                : ((await ctx.spawnChildSession!({
                    agentProfile: item.definition.profile,
                    prompt: item.task,
                    swarm: {
                      swarmId: ctx.toolCallId,
                      itemId: item.itemId,
                    },
                    abortSignal: deadline.signal,
                    onReady,
                  })) as ChildExecutionResult);
            const effectiveResult: ChildExecutionResult = deadline.timedOut()
              ? timedOutChildResult(result, itemTimeoutMs)
              : result;
            for (const artifactId of effectiveResult.artifactIds)
              artifactIds[index]!.add(artifactId);
            const observedResult = {
              ...effectiveResult,
              artifactIds: [...artifactIds[index]!],
            };
            childResults[index] = observedResult;
            if (
              effectiveResult.status === 'failed' &&
              effectiveResult.failureClass === 'RateLimit' &&
              effectiveResult.runId &&
              ctx.retryChildAgent
            ) {
              return {
                status: 'rate_limited' as const,
                retry: {
                  sourceRunId: effectiveResult.runId,
                  ...(effectiveResult.childSessionId
                    ? {
                        execution: {
                          kind: 'child_session' as const,
                          sessionId: effectiveResult.childSessionId,
                          currentRunId: effectiveResult.runId,
                        },
                      }
                    : {}),
                },
                reason: new ProviderRateLimitRetry(effectiveResult),
              };
            }
            traceAgentSwarm(
              ctx,
              effectiveResult.status === 'failed' ? 'tool_failed' : 'tool_completed',
              'item_completed',
              {
                itemId: item.itemId,
                index: item.index,
                profile: item.profile,
                mode: item.mode,
                ...(item.resumedFromRunId ? { resumedFromRunId: item.resumedFromRunId } : {}),
                status: effectiveResult.status,
                ...(effectiveResult.childSessionId
                  ? { childSessionId: effectiveResult.childSessionId }
                  : {}),
                turnId: effectiveResult.turnId,
                ...(effectiveResult.runId ? { runId: effectiveResult.runId } : {}),
                durationMs: effectiveResult.durationMs,
                artifactCount: effectiveResult.artifactIds.length,
                ...(effectiveResult.failureClass
                  ? { failureClass: effectiveResult.failureClass }
                  : {}),
              },
            );
            ctx.emitOutput(
              effectiveResult.status === 'failed' ? 'stderr' : 'stdout',
              `Agent swarm item ${item.itemId}: ${effectiveResult.status}\n`,
            );
            return { status: 'fulfilled' as const, value: observedResult };
          } catch (error) {
            const effectiveError = deadline.timedOut()
              ? new AgentSwarmItemTimeoutError(itemTimeoutMs)
              : error;
            traceAgentSwarm(ctx, 'tool_failed', 'item_completed', {
              itemId: item.itemId,
              index: item.index,
              profile: item.profile,
              mode: item.mode,
              ...(item.resumedFromRunId ? { resumedFromRunId: item.resumedFromRunId } : {}),
              status: ctx.abortSignal.aborted ? 'cancelled' : 'failed',
              failureClass: boundedFailureClass(effectiveError, 'ChildAgentError'),
            });
            ctx.emitOutput(
              'stderr',
              `Agent swarm item ${item.itemId} failed: ${boundedSwarmError(effectiveError)}\n`,
            );
            throw effectiveError;
          } finally {
            deadline.cleanup();
          }
        },
        {
          maxConcurrency: prepared.maxConcurrency,
          signal: ctx.abortSignal,
          ...(deps.adaptiveSwarmPolicy ? { policy: deps.adaptiveSwarmPolicy } : {}),
          onRateLimit: ({ index, attempt, retryDelayMs, capacity }) => {
            const item = prepared.items[index]!;
            traceAgentSwarm(ctx, 'tool_started', 'item_suspended', {
              itemId: item.itemId,
              index,
              profile: item.profile,
              attempt,
              retryDelayMs,
              capacity,
              failureClass: 'RateLimit',
            });
            ctx.emitOutput(
              'stderr',
              `Agent swarm item ${item.itemId} rate limited; retrying in ${retryDelayMs}ms\n`,
            );
          },
          onCapacityChanged: ({ direction, capacity }) => {
            traceAgentSwarm(ctx, 'tool_started', 'capacity_changed', {
              direction,
              capacity,
            });
          },
        },
      );

      const items = rows.map((row, index) =>
        mapAgentSwarmItem(prepared.items[index]!, row, readyRefs[index], childResults[index]),
      );
      const completedAt = now();
      const status = aggregateAgentSwarmStatus(items);
      ctx.emitOutput('stdout', `Agent swarm: ${status}\n`);
      const result: AgentSwarmToolResult = {
        kind: 'agent_swarm',
        status,
        items,
        startedAt,
        completedAt,
        durationMs: Math.max(0, completedAt - startedAt),
      };
      traceAgentSwarm(ctx, 'tool_completed', 'batch_completed', {
        ...projectAgentSwarmResult(result),
        resumedItemCount: prepared.items.filter((item) => item.mode === 'resume').length,
      });
      return result;
    },
  };
}

function traceAgentSwarm(
  ctx: MakaToolContext,
  type: 'tool_started' | 'tool_completed' | 'tool_failed',
  stage:
    | 'batch_started'
    | 'item_queued'
    | 'item_started'
    | 'item_suspended'
    | 'capacity_changed'
    | 'item_completed'
    | 'batch_completed',
  data: Record<string, unknown>,
): void {
  ctx.emitRunTrace?.(type, `Agent swarm ${stage.replaceAll('_', ' ')}`, {
    swarmStage: stage,
    ...data,
  });
}

function agentSwarmInputSchema() {
  const itemSchema = z
    .object({
      item_id: z
        .string()
        .min(1)
        .max(TASK_ID_MAX_CHARS)
        .refine(isSafeTaskId)
        .describe('Stable item id (letters, digits, dot, underscore, colon, or dash).'),
      profile: z.enum(BUILTIN_AGENT_PROFILES).describe('Child agent profile.'),
      task: z
        .string()
        .min(1)
        .max(AGENT_SWARM_TASK_MAX_CHARS)
        .describe('Bounded, self-contained task for this item.'),
      write_back: z
        .enum(AGENT_SWARM_WRITE_BACK_MODES)
        .optional()
        .describe('Requested child write-back mode.'),
      isolation: z
        .enum(AGENT_SWARM_ISOLATION_MODES)
        .optional()
        .describe('Requested child workspace isolation.'),
    })
    .superRefine((input, ctx) => {
      addAgentContractIssues(input, ctx);
    });

  const explicitItemsSchema = z
    .array(itemSchema)
    .min(1)
    .max(AGENT_SWARM_MAX_ITEMS)
    .superRefine((items, ctx) => {
      const seen = new Set<string>();
      for (let index = 0; index < items.length; index += 1) {
        const itemId = items[index]!.item_id;
        if (seen.has(itemId)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [index, 'item_id'],
            message: `Duplicate agent swarm item_id "${itemId}".`,
          });
        }
        seen.add(itemId);
      }
    });
  const templateItemsSchema = z.array(z.string().trim().min(1)).min(1).max(AGENT_SWARM_MAX_ITEMS);

  return z
    .object({
      items: z.union([explicitItemsSchema, templateItemsSchema]).optional(),
      prompt_template: z
        .string()
        .trim()
        .min(1)
        .max(AGENT_SWARM_TASK_MAX_CHARS)
        .optional()
        .describe(
          `Shared task template for string items; every ${AGENT_SWARM_PROMPT_TEMPLATE_PLACEHOLDER} occurrence is replaced.`,
        ),
      profile: z
        .enum(BUILTIN_AGENT_PROFILES)
        .optional()
        .describe('Shared child profile for prompt_template string items.'),
      resume_run_ids: z
        .record(z.string().trim().min(1), z.string().trim().min(1).max(AGENT_SWARM_TASK_MAX_CHARS))
        .optional()
        .describe('Map of terminal child AgentRun runId to its continuation prompt.'),
      max_concurrency: z
        .number()
        .int()
        .min(1)
        .max(AGENT_SWARM_MAX_CONCURRENCY)
        .default(AGENT_SWARM_DEFAULT_CONCURRENCY)
        .describe('Maximum number of child items active inside this batch.'),
    })
    .superRefine((input, ctx) => {
      const resumeCount = Object.keys(input.resume_run_ids ?? {}).length;
      const itemCount = input.items?.length ?? 0;
      if (resumeCount + itemCount < 1) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Agent swarm requires at least one item or resume_run_ids entry.',
        });
      }
      if (resumeCount + itemCount > AGENT_SWARM_MAX_ITEMS) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Agent swarm supports at most ${AGENT_SWARM_MAX_ITEMS} total items.`,
        });
      }

      if (!input.items) {
        if (input.prompt_template !== undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['prompt_template'],
            message: 'prompt_template requires string items.',
          });
        }
        if (input.profile !== undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['profile'],
            message: 'profile requires string items.',
          });
        }
        return;
      }

      const templateItems = input.items.every((item) => typeof item === 'string');
      if (!templateItems) {
        if (input.prompt_template !== undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['prompt_template'],
            message: 'prompt_template is only valid when items are strings.',
          });
        }
        if (input.profile !== undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['profile'],
            message: 'profile is specified per item when items are structured.',
          });
        }
        return;
      }

      if (input.prompt_template === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['prompt_template'],
          message: 'prompt_template is required when items are strings.',
        });
        return;
      }
      if (input.profile === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['profile'],
          message: 'profile is required when items are strings.',
        });
      }
      if (!input.prompt_template.includes(AGENT_SWARM_PROMPT_TEMPLATE_PLACEHOLDER)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['prompt_template'],
          message: `prompt_template must include ${AGENT_SWARM_PROMPT_TEMPLATE_PLACEHOLDER}.`,
        });
        return;
      }

      const seenTasks = new Set<string>();
      for (let index = 0; index < input.items.length; index += 1) {
        const item = input.items[index];
        if (typeof item !== 'string') continue;
        const task = expandAgentSwarmPromptTemplate(input.prompt_template, item);
        if (task.length > AGENT_SWARM_TASK_MAX_CHARS) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['items', index],
            message: `Expanded agent swarm task exceeds ${AGENT_SWARM_TASK_MAX_CHARS} characters.`,
          });
        }
        if (seenTasks.has(task)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['items', index],
            message: 'Template items must produce distinct agent swarm tasks.',
          });
        }
        seenTasks.add(task);
      }
    });
}

function addAgentContractIssues(input: AgentSwarmExplicitItemInput, ctx: z.RefinementCtx): void {
  const definition = requireBuiltinAgentDefinitionByProfile(input.profile);
  const writeBack = input.write_back ?? definition.contract.defaultWriteBack;
  if (!definition.contract.supportedWriteBack.some((mode) => mode === writeBack)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['write_back'],
      message: `Agent profile "${definition.profile}" does not support write_back "${writeBack}".`,
    });
  }
  const isolation = input.isolation ?? definition.contract.workspace;
  if (isolation !== definition.contract.workspace) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['isolation'],
      message: `Agent profile "${definition.profile}" requires isolation "${definition.contract.workspace}", not "${isolation}".`,
    });
  }
}

async function prepareAgentSwarmInput(
  input: AgentSwarmToolInput,
  ctx: MakaToolContext,
): Promise<{
  readonly items: readonly PreparedAgentSwarmItem[];
  readonly maxConcurrency: number;
}> {
  const preflight = preflightAgentSwarmInput(input);
  if (preflight.items.length > 0 && !ctx.spawnChildSession) {
    throw new Error('spawnChildSession capability is unavailable in this runtime context');
  }
  if (preflight.resumes.length > 0 && (!ctx.prepareChildAgentResume || !ctx.resumeChildAgent)) {
    throw new Error('Child AgentRun resume capability is unavailable in this runtime context');
  }
  const resumes = await Promise.all(
    preflight.resumes.map(async (item): Promise<PreparedAgentSwarmItem> => {
      const prepared = await ctx.prepareChildAgentResume!(item.sourceRunId);
      if (prepared.sourceRunId !== item.sourceRunId) {
        throw new Error(`Child AgentRun resume identity changed for ${item.sourceRunId}`);
      }
      const definition = requireBuiltinAgentDefinitionByProfile(prepared.profile);
      if (definition.id !== prepared.agentId || definition.name !== prepared.agentName) {
        throw new Error(`Child AgentRun resume profile changed for ${item.sourceRunId}`);
      }
      return {
        index: item.index,
        itemId: item.itemId,
        profile: definition.profile,
        task: item.task,
        definition,
        mode: 'resume',
        resumedFromRunId: item.sourceRunId,
        execution: prepared.execution,
      };
    }),
  );
  const linkedChildSessions = new Set<string>();
  for (const resume of resumes) {
    if (resume.execution?.kind !== 'child_session') continue;
    if (linkedChildSessions.has(resume.execution.sessionId)) {
      throw new Error(
        `Agent swarm cannot resume child Session ${resume.execution.sessionId} more than once`,
      );
    }
    linkedChildSessions.add(resume.execution.sessionId);
  }
  return {
    items: [...resumes, ...preflight.items],
    maxConcurrency: preflight.maxConcurrency,
  };
}

function preflightAgentSwarmInput(input: AgentSwarmToolInput): {
  readonly items: readonly PreparedAgentSwarmItem[];
  readonly resumes: readonly PendingAgentSwarmResume[];
  readonly maxConcurrency: number;
} {
  const resumeEntries = Object.entries(input.resume_run_ids ?? {});
  const explicitItems = normalizeAgentSwarmItems(input);
  const totalItems = resumeEntries.length + explicitItems.length;
  if (totalItems < 1) {
    throw new Error('Agent swarm requires at least one item or resume_run_ids entry.');
  }
  if (totalItems > AGENT_SWARM_MAX_ITEMS) {
    throw new Error(`Agent swarm supports at most ${AGENT_SWARM_MAX_ITEMS} total items.`);
  }
  const maxConcurrency = input.max_concurrency ?? AGENT_SWARM_DEFAULT_CONCURRENCY;
  if (
    !Number.isSafeInteger(maxConcurrency) ||
    maxConcurrency < 1 ||
    maxConcurrency > AGENT_SWARM_MAX_CONCURRENCY
  ) {
    throw new Error(
      `Agent swarm max_concurrency must be an integer from 1 to ${AGENT_SWARM_MAX_CONCURRENCY}.`,
    );
  }

  const resumes = resumeEntries.map(([sourceRunId, prompt], index): PendingAgentSwarmResume => {
    if (sourceRunId.trim().length < 1) {
      throw new Error(`Agent swarm resume entry ${index} has an invalid runId.`);
    }
    if (
      typeof prompt !== 'string' ||
      prompt.trim().length < 1 ||
      prompt.trim().length > AGENT_SWARM_TASK_MAX_CHARS
    ) {
      throw new Error(`Agent swarm resume entry ${sourceRunId} has an invalid prompt.`);
    }
    return {
      index,
      itemId: `resume-${index + 1}`,
      sourceRunId: sourceRunId.trim(),
      task: prompt.trim(),
    };
  });
  const seen = new Set<string>();
  const items = explicitItems.map((item, index): PreparedAgentSwarmItem => {
    if (!isSafeTaskId(item.item_id)) {
      throw new Error(`Agent swarm item ${index} has an invalid item_id.`);
    }
    if (seen.has(item.item_id)) {
      throw new Error(`Duplicate agent swarm item_id "${item.item_id}".`);
    }
    seen.add(item.item_id);
    if (
      typeof item.task !== 'string' ||
      item.task.length < 1 ||
      item.task.length > AGENT_SWARM_TASK_MAX_CHARS
    ) {
      throw new Error(`Agent swarm item "${item.item_id}" has an invalid task.`);
    }

    const definition = requireBuiltinAgentDefinitionByProfile(item.profile);
    const writeBack = item.write_back ?? definition.contract.defaultWriteBack;
    if (!definition.contract.supportedWriteBack.some((mode) => mode === writeBack)) {
      throw new Error(
        `Agent profile "${definition.profile}" does not support write_back "${writeBack}".`,
      );
    }
    const isolation = item.isolation ?? definition.contract.workspace;
    if (isolation !== definition.contract.workspace) {
      throw new Error(
        `Agent profile "${definition.profile}" requires isolation "${definition.contract.workspace}", not "${isolation}".`,
      );
    }
    if (isolation !== AGENT_WORKSPACE_SAME_WORKSPACE) {
      throw new Error(
        `Agent profile "${definition.profile}" requires "${isolation}" workspace isolation, but this runtime does not provide a worktree child executor yet.`,
      );
    }

    return {
      index: resumes.length + index,
      itemId: item.item_id,
      profile: definition.profile,
      task: item.task,
      definition,
      mode: 'spawn',
    };
  });
  return { items, resumes, maxConcurrency };
}

function normalizeAgentSwarmItems(input: AgentSwarmToolInput): AgentSwarmExplicitItemInput[] {
  if (!('items' in input) || !input.items) {
    if ('prompt_template' in input || 'profile' in input) {
      throw new Error('prompt_template and shared profile require string items.');
    }
    return [];
  }
  const stringItemCount = input.items.filter((item) => typeof item === 'string').length;
  if (stringItemCount === 0) {
    if ('prompt_template' in input || 'profile' in input) {
      throw new Error('prompt_template and shared profile are only valid when items are strings.');
    }
    return input.items;
  }
  if (stringItemCount !== input.items.length) {
    throw new Error('Agent swarm items must be either all structured items or all strings.');
  }
  if (!('prompt_template' in input) || typeof input.prompt_template !== 'string') {
    throw new Error('prompt_template is required when agent swarm items are strings.');
  }
  if (!('profile' in input) || typeof input.profile !== 'string') {
    throw new Error('profile is required when agent swarm items are strings.');
  }

  const promptTemplate = input.prompt_template.trim();
  if (!promptTemplate.includes(AGENT_SWARM_PROMPT_TEMPLATE_PLACEHOLDER)) {
    throw new Error(`prompt_template must include ${AGENT_SWARM_PROMPT_TEMPLATE_PLACEHOLDER}.`);
  }
  const seenTasks = new Set<string>();
  return input.items.map((rawItem, index) => {
    const item = rawItem.trim();
    if (item.length < 1) {
      throw new Error(`Agent swarm template item ${index} must not be empty.`);
    }
    const task = expandAgentSwarmPromptTemplate(promptTemplate, item);
    if (task.length > AGENT_SWARM_TASK_MAX_CHARS) {
      throw new Error(
        `Expanded agent swarm task ${index} exceeds ${AGENT_SWARM_TASK_MAX_CHARS} characters.`,
      );
    }
    if (seenTasks.has(task)) {
      throw new Error(`Agent swarm template item ${index} produces a duplicate task.`);
    }
    seenTasks.add(task);
    return {
      item_id: `item-${index + 1}`,
      profile: input.profile,
      task,
    };
  });
}

function expandAgentSwarmPromptTemplate(promptTemplate: string, item: string): string {
  return promptTemplate.split(AGENT_SWARM_PROMPT_TEMPLATE_PLACEHOLDER).join(item);
}

function mapAgentSwarmItem(
  item: PreparedAgentSwarmItem,
  row: AdaptiveSwarmItemResult<ChildExecutionResult>,
  ready: StartedChildRef | undefined,
  observed: ChildExecutionResult | undefined,
): AgentSwarmToolResult['items'][number] {
  if (row.status === 'fulfilled') {
    return mapChildResult(
      item,
      row.value,
      row.value.status === 'cancelled'
        ? 'cancelled'
        : row.value.status === 'completed'
          ? 'completed'
          : 'failed',
    );
  }
  if (row.status === 'rejected') {
    if (observed) {
      return mapChildResult(item, observed, 'failed');
    }
    return {
      itemId: item.itemId,
      index: row.index,
      profile: item.profile,
      started: ready !== undefined,
      ...(item.resumedFromRunId ? { resumedFromRunId: item.resumedFromRunId } : {}),
      ...(ready ?? {}),
      status: 'failed',
      summary: boundedSwarmError(row.reason),
      artifactIds: [],
      failureClass: boundedFailureClass(row.reason, 'ChildAgentError'),
    };
  }
  if (observed) {
    return mapChildResult(item, observed, 'cancelled');
  }
  return {
    itemId: item.itemId,
    index: row.index,
    profile: item.profile,
    started: ready !== undefined,
    ...(item.resumedFromRunId ? { resumedFromRunId: item.resumedFromRunId } : {}),
    ...(ready ?? {}),
    status: 'cancelled',
    summary: ready
      ? 'Child run was cancelled with its parent swarm.'
      : 'Item was cancelled before its child run started.',
    artifactIds: [],
    failureClass: 'ParentCancelled',
  };
}

class ProviderRateLimitRetry extends Error {
  constructor(readonly result: SpawnChildAgentResult) {
    super(result.summary || 'Child agent provider rate limited');
    this.name = 'RateLimit';
  }
}

class AgentSwarmItemTimeoutError extends Error {
  readonly failureClass = 'Timeout';

  constructor(readonly timeoutMs: number) {
    super(`Child agent timed out after ${formatDuration(timeoutMs)}.`);
    this.name = 'Timeout';
  }
}

function normalizeItemTimeoutMs(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error('Agent swarm item timeout must be a non-negative integer in milliseconds.');
  }
  return value;
}

function createItemDeadline(
  parentSignal: AbortSignal,
  timeoutMs: number,
): {
  readonly signal: AbortSignal;
  timedOut(): boolean;
  cleanup(): void;
} {
  if (timeoutMs === 0) {
    return { signal: parentSignal, timedOut: () => false, cleanup: () => {} };
  }
  const controller = new AbortController();
  let expired = false;
  const abortFromParent = () => controller.abort(parentSignal.reason);
  if (parentSignal.aborted) abortFromParent();
  else parentSignal.addEventListener('abort', abortFromParent, { once: true });
  const timer = setTimeout(() => {
    if (controller.signal.aborted) return;
    expired = true;
    controller.abort(new AgentSwarmItemTimeoutError(timeoutMs));
  }, timeoutMs);
  return {
    signal: controller.signal,
    timedOut: () => expired,
    cleanup: () => {
      clearTimeout(timer);
      parentSignal.removeEventListener('abort', abortFromParent);
    },
  };
}

function timedOutChildResult(
  result: ChildExecutionResult,
  timeoutMs: number,
): ChildExecutionResult {
  return {
    ...result,
    status: 'failed',
    summary: `Child agent timed out after ${formatDuration(timeoutMs)}.`,
    failureClass: 'Timeout',
  };
}

function formatDuration(ms: number): string {
  if (ms % 3_600_000 === 0) {
    const hours = ms / 3_600_000;
    return `${hours} hour${hours === 1 ? '' : 's'}`;
  }
  if (ms % 60_000 === 0) {
    const minutes = ms / 60_000;
    return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  }
  if (ms % 1_000 === 0) {
    const seconds = ms / 1_000;
    return `${seconds} second${seconds === 1 ? '' : 's'}`;
  }
  return `${ms} ms`;
}

function mapChildResult(
  item: PreparedAgentSwarmItem,
  result: ChildExecutionResult,
  status: AgentSwarmToolResult['items'][number]['status'],
): AgentSwarmToolResult['items'][number] {
  return {
    itemId: item.itemId,
    index: item.index,
    profile: item.profile,
    started: true,
    agentId: result.agentId,
    agentName: result.agentName,
    ...(result.childSessionId ? { childSessionId: result.childSessionId } : {}),
    turnId: result.turnId,
    ...(result.runId ? { runId: result.runId } : {}),
    ...(item.resumedFromRunId ? { resumedFromRunId: item.resumedFromRunId } : {}),
    status,
    summary: result.summary,
    artifactIds: result.artifactIds,
    startedAt: result.startedAt,
    completedAt: result.completedAt,
    durationMs: result.durationMs,
    ...(result.failureClass ? { failureClass: result.failureClass } : {}),
  };
}

function aggregateAgentSwarmStatus(
  items: AgentSwarmToolResult['items'],
): AgentSwarmToolResult['status'] {
  if (items.some((item) => item.status === 'cancelled')) return 'cancelled';
  if (items.every((item) => item.status === 'completed')) return 'completed';
  return 'partial';
}

function boundedSwarmError(error: unknown): string {
  const message = redactSecrets(
    error instanceof Error ? error.message : String(error ?? 'unknown error'),
  );
  return message.length <= AGENT_SWARM_ERROR_MAX_CHARS
    ? message
    : `${message.slice(0, AGENT_SWARM_ERROR_MAX_CHARS - 1)}…`;
}

function boundedFailureClass(error: unknown, fallback: string): string {
  const value = error instanceof Error && error.name.trim() ? error.name : fallback;
  return boundedSwarmError(value);
}
