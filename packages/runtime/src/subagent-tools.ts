import { z } from 'zod';
import {
  TASK_ID_MAX_CHARS,
  isSafeTaskId,
  type TaskLedgerStore,
  type ToolResultContent,
} from '@maka/core';
import type { MakaTool, MakaToolContext } from './tool-runtime.js';
import {
  AGENT_WORKSPACE_SAME_WORKSPACE,
  AGENT_WORKSPACE_WORKTREE,
  AGENT_WRITE_BACK_PATCH,
  AGENT_WRITE_BACK_SUMMARY,
  BUILTIN_AGENT_DEFINITIONS,
  BUILTIN_AGENT_PROFILES,
  buildToolsForAgentDefinition,
  requireBuiltinAgentDefinitionByProfile,
} from './agent-catalog.js';
import { AGENT_TEAM_CHILD_TOOL_NAMES } from './agent-team-tool-names.js';
import { AGENT_SWARM_TOOL_NAME, buildAgentSwarmTool } from './agent-swarm-tools.js';
import { ChildAgentProgressProjector } from './child-agent-progress.js';

export const AGENT_SPAWN_TOOL_NAME = 'agent_spawn';
export const AGENT_LIST_TOOL_NAME = 'agent_list';
export const AGENT_OUTPUT_TOOL_NAME = 'agent_output';
export const AGENT_TOOL_GROUP_ID = 'agent';
export const AGENT_TOOL_NAMES = [
  AGENT_SPAWN_TOOL_NAME,
  AGENT_SWARM_TOOL_NAME,
  AGENT_LIST_TOOL_NAME,
  AGENT_OUTPUT_TOOL_NAME,
] as const;
const CHILD_RECOVERY_TOOL_NAMES = ['ArchiveRead'] as const;
export const CHILD_AGENT_TOOL_NAMES = [
  ...new Set(BUILTIN_AGENT_DEFINITIONS.flatMap((definition) => definition.tools)),
] as readonly string[];
const AGENT_SPAWN_WRITE_BACK_MODES = [AGENT_WRITE_BACK_SUMMARY, AGENT_WRITE_BACK_PATCH] as const;
const AGENT_SPAWN_ISOLATION_MODES = [
  AGENT_WORKSPACE_SAME_WORKSPACE,
  AGENT_WORKSPACE_WORKTREE,
] as const;
const CHILD_PROGRESS_ERROR_MAX_CHARS = 1_000;

type SubagentToolResult = Extract<ToolResultContent, { kind: 'subagent' }>;

export function buildChildAgentTools(tools: readonly MakaTool[]): MakaTool[] {
  const seen = new Set<string>();
  const out: MakaTool[] = [];
  for (const definition of BUILTIN_AGENT_DEFINITIONS) {
    for (const tool of buildToolsForAgentDefinition(tools, definition)) {
      if (seen.has(tool.name)) continue;
      seen.add(tool.name);
      out.push(tool);
    }
  }
  // Runtime recovery tools are capability-dependent and must follow a child
  // whenever the host provides them. Otherwise a child can receive an archive
  // placeholder that explicitly names ArchiveRead without having that tool.
  for (const name of CHILD_RECOVERY_TOOL_NAMES) {
    const tool = tools.find((candidate) => candidate.name === name);
    if (!tool || seen.has(name)) continue;
    seen.add(name);
    out.push(tool);
  }
  for (const name of AGENT_TEAM_CHILD_TOOL_NAMES) {
    const tool = tools.find((candidate) => candidate.name === name);
    if (!tool || seen.has(name)) continue;
    seen.add(name);
    out.push(tool);
  }
  return out;
}

export function buildSubagentSpawnTool(deps: { taskLedger?: TaskLedgerStore } = {}): MakaTool<
  {
    profile: string;
    task: string;
    write_back?: string;
    isolation?: string;
    task_id?: string;
  },
  unknown
> {
  return {
    name: AGENT_SPAWN_TOOL_NAME,
    displayName: 'Agent',
    description:
      'Run a foreground catalog child agent for a bounded task and return its explicit result.',
    parameters: z
      .object({
        profile: z.enum(BUILTIN_AGENT_PROFILES).describe('Child agent profile.'),
        task: z.string().min(1).max(60_000).describe('Bounded task for the selected child agent.'),
        write_back: z
          .enum(AGENT_SPAWN_WRITE_BACK_MODES)
          .optional()
          .describe(
            'Requested child write-back mode. Each built-in profile declares its supported modes.',
          ),
        isolation: z
          .enum(AGENT_SPAWN_ISOLATION_MODES)
          .optional()
          .describe(
            'Requested child workspace isolation. Worktree profiles fail closed until a worktree child executor is available.',
          ),
        ...(deps.taskLedger
          ? {
              task_id: z
                .string()
                .min(1)
                .max(TASK_ID_MAX_CHARS)
                .refine(isSafeTaskId)
                .optional()
                .describe('Existing task UUID or short key to bind to this child run.'),
            }
          : {}),
      })
      .strict()
      .superRefine((input, ctx) => {
        const definition = requireBuiltinAgentDefinitionByProfile(input.profile);
        const requestedWriteBack = input.write_back ?? definition.contract.defaultWriteBack;
        if (!definition.contract.supportedWriteBack.some((mode) => mode === requestedWriteBack)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['write_back'],
            message: `Agent profile "${definition.profile}" does not support write_back "${requestedWriteBack}".`,
          });
        }
        const requestedIsolation = input.isolation ?? definition.contract.workspace;
        if (requestedIsolation !== definition.contract.workspace) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['isolation'],
            message: `Agent profile "${definition.profile}" requires isolation "${definition.contract.workspace}", not "${requestedIsolation}".`,
          });
        }
      }),
    categoryHint: 'subagent',
    impl: async (input, ctx) => {
      const definition = requireBuiltinAgentDefinitionByProfile(input.profile);
      const requestedWriteBack = input.write_back ?? definition.contract.defaultWriteBack;
      if (!definition.contract.supportedWriteBack.some((mode) => mode === requestedWriteBack)) {
        throw new Error(
          `Agent profile "${definition.profile}" does not support write_back "${requestedWriteBack}".`,
        );
      }
      const requestedIsolation = input.isolation ?? definition.contract.workspace;
      if (requestedIsolation !== definition.contract.workspace) {
        throw new Error(
          `Agent profile "${definition.profile}" requires isolation "${definition.contract.workspace}", not "${requestedIsolation}".`,
        );
      }
      if (!ctx.spawnChildSession) {
        throw new Error('spawnChildSession capability is unavailable in this runtime context');
      }
      const boundTask = input.task_id
        ? await deps.taskLedger?.get(ctx.sessionId, input.task_id)
        : undefined;
      if (input.task_id && !deps.taskLedger)
        throw new Error('Task binding is unavailable in this runtime');
      if (input.task_id && !boundTask)
        throw new Error(`No such task in this session: ${input.task_id}`);
      let claimedOwner:
        | {
            actor: 'child_agent';
            sessionId: string;
            agentId: string;
            turnId: string;
          }
        | undefined;
      let result: Omit<SubagentToolResult, 'kind'>;
      const progress = new ChildAgentProgressProjector(ctx);
      ctx.emitOutput('stdout', `Starting child agent: ${definition.name}\n`);
      try {
        result = (await ctx.spawnChildSession({
          agentProfile: definition.profile,
          prompt: input.task,
          ...(boundTask
            ? {
                onReady: async ({ childSessionId, turnId, agentId }) => {
                  const owner = {
                    actor: 'child_agent' as const,
                    sessionId: childSessionId,
                    agentId,
                    turnId,
                  };
                  await deps.taskLedger!.claim(ctx.sessionId, boundTask.id, owner, {
                    runId: ctx.runId,
                    turnId: ctx.turnId,
                    toolCallId: ctx.toolCallId,
                    source: 'system',
                    actor: 'main_agent',
                    reason: `assigned to child agent ${agentId}`,
                  });
                  claimedOwner = owner;
                },
              }
            : {}),
          onEvent: (event) => progress.observe(event),
        })) as Omit<SubagentToolResult, 'kind'>;
      } catch (error) {
        ctx.emitOutput(
          'stderr',
          `Child agent ${definition.name} failed: ${boundedChildError(error)}\n`,
        );
        if (boundTask && claimedOwner) {
          await deps.taskLedger!.settleAgentOutcome(
            ctx.sessionId,
            boundTask.id,
            {
              status: 'failed',
              owner: claimedOwner,
              reason:
                error instanceof Error
                  ? error.message
                  : 'Child agent failed before returning a result',
            },
            {
              turnId: claimedOwner.turnId,
              toolCallId: ctx.toolCallId,
              source: 'system',
              actor: 'child_agent',
            },
          );
        }
        throw error;
      }
      ctx.emitOutput('stdout', `Child agent ${definition.name}: ${result.status}\n`);
      if (boundTask && claimedOwner) {
        const owner = {
          ...claimedOwner,
          ...(result.runId ? { runId: result.runId } : {}),
          turnId: result.turnId,
        };
        await deps.taskLedger!.settleAgentOutcome(
          ctx.sessionId,
          boundTask.id,
          {
            status: result.status,
            owner,
            reason: result.failureClass ?? result.summary,
          },
          {
            runId: result.runId,
            turnId: result.turnId,
            toolCallId: ctx.toolCallId,
            source: 'system',
            actor: 'child_agent',
          },
        );
      }
      return {
        kind: 'subagent',
        ...result,
      } satisfies SubagentToolResult;
    },
  };
}

function boundedChildError(error: unknown): string {
  const message = error instanceof Error ? error.message : 'unknown error';
  return message.length <= CHILD_PROGRESS_ERROR_MAX_CHARS
    ? message
    : `${message.slice(0, CHILD_PROGRESS_ERROR_MAX_CHARS - 1)}…`;
}

export function buildSubagentListTool(): MakaTool<Record<string, never>, unknown> {
  return {
    name: AGENT_LIST_TOOL_NAME,
    displayName: 'Agent List',
    description:
      'List available agent catalog definitions and child agent runs for the current session.',
    parameters: z.object({}),
    categoryHint: 'read',
    impl: async (_input, ctx) => {
      if (!ctx.listChildAgents) {
        throw new Error('listChildAgents capability is unavailable in this runtime context');
      }
      return await ctx.listChildAgents();
    },
  };
}

export function buildSubagentOutputTool(): MakaTool<
  {
    locator?: 'child_session_latest' | 'child_session_run' | 'legacy_run' | 'legacy_turn';
    child_session_id?: string;
    run_id?: string;
    turn_id?: string;
    max_events?: number;
    max_bytes?: number;
    view?: 'result' | 'events' | 'runtime_events' | 'all';
  },
  unknown
> {
  return {
    name: AGENT_OUTPUT_TOOL_NAME,
    displayName: 'Agent Output',
    description:
      'Inspect bounded child output. Use view=result for the final committed model text plus its Graph result record id; runtime_events is the default compatibility view. Always set locator: child_session_run for a graph childSessionId/currentRunId, child_session_latest for its latest run, or a legacy locator. Use view=all only for targeted diagnostics.',
    parameters: z
      .object({
        locator: z
          .enum(['child_session_latest', 'child_session_run', 'legacy_run', 'legacy_turn'])
          .optional()
          .describe(
            'Explicit locator discriminator. The runtime applies only fields selected by this value.',
          ),
        child_session_id: z
          .string()
          .min(1)
          .optional()
          .describe('Linked child Session id. Without run_id, inspects its latest AgentRun.'),
        run_id: z.string().min(1).optional(),
        turn_id: z.string().min(1).optional(),
        max_events: z.number().int().min(1).max(100).optional(),
        max_bytes: z
          .number()
          .int()
          .min(1024)
          .max(128 * 1024)
          .optional(),
        view: z.enum(['result', 'events', 'runtime_events', 'all']).optional(),
      })
      .superRefine((input, ctx) => {
        if (input.locator) {
          const valid =
            (input.locator === 'child_session_latest' && Boolean(input.child_session_id)) ||
            (input.locator === 'child_session_run' &&
              Boolean(input.child_session_id) &&
              Boolean(input.run_id)) ||
            (input.locator === 'legacy_run' && Boolean(input.run_id)) ||
            (input.locator === 'legacy_turn' && Boolean(input.turn_id));
          if (!valid) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: `locator=${input.locator} requires its matching identity fields`,
            });
          }
          return;
        }
        if (input.child_session_id) {
          if (input.turn_id) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ['turn_id'],
              message: 'turn_id cannot be combined with child_session_id',
            });
          }
          return;
        }
        if (Number(!!input.run_id) + Number(!!input.turn_id) !== 1) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'Provide child_session_id, or exactly one legacy run_id/turn_id',
          });
        }
      }),
    categoryHint: 'read',
    impl: async (input, ctx) => {
      if (!ctx.readChildAgentOutput) {
        throw new Error('readChildAgentOutput capability is unavailable in this runtime context');
      }
      const explicitLocator =
        input.locator === 'child_session_latest'
          ? {
              execution: {
                kind: 'child_session' as const,
                sessionId: input.child_session_id!,
              },
            }
          : input.locator === 'child_session_run'
            ? {
                execution: {
                  kind: 'child_session' as const,
                  sessionId: input.child_session_id!,
                  currentRunId: input.run_id!,
                },
              }
            : input.locator === 'legacy_run'
              ? {
                  execution: {
                    kind: 'legacy_child_run' as const,
                    sessionId: ctx.sessionId,
                    runId: input.run_id!,
                  },
                }
              : input.locator === 'legacy_turn'
                ? { turnId: input.turn_id! }
                : undefined;
      return await ctx.readChildAgentOutput({
        ...(explicitLocator ??
          (input.child_session_id
            ? {
                execution: {
                  kind: 'child_session' as const,
                  sessionId: input.child_session_id,
                  ...(input.run_id ? { currentRunId: input.run_id } : {}),
                },
              }
            : input.run_id
              ? {
                  execution: {
                    kind: 'legacy_child_run' as const,
                    sessionId: ctx.sessionId,
                    runId: input.run_id,
                  },
                }
              : {})),
        ...(input.locator === undefined && input.turn_id ? { turnId: input.turn_id } : {}),
        ...(input.max_events !== undefined ? { maxEvents: input.max_events } : {}),
        ...(input.max_bytes !== undefined ? { maxBytes: input.max_bytes } : {}),
        ...(input.view !== undefined ? { view: input.view } : {}),
      });
    },
  };
}

export function buildSubagentProjectionTools(): MakaTool[] {
  return [buildSubagentListTool(), buildSubagentOutputTool()];
}

export function buildParentAgentTools(deps: { taskLedger?: TaskLedgerStore } = {}): MakaTool[] {
  return [buildSubagentSpawnTool(deps), buildAgentSwarmTool(), ...buildSubagentProjectionTools()];
}
