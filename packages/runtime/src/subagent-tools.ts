import { z } from 'zod';
import {
  TASK_ID_MAX_CHARS,
  decodeCanonicalToolResultContent,
  isSafeTaskId,
  isSafeSubagentPresetId,
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
  agentProfilesForDefinitions,
  buildToolsForAgentDefinition,
  requireAgentDefinitionByProfile,
  type AgentDefinition,
} from './agent-catalog.js';
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
export const CHILD_AGENT_TOOL_NAMES = [
  ...new Set(BUILTIN_AGENT_DEFINITIONS.flatMap((definition) => definition.tools)),
] as readonly string[];
const AGENT_SPAWN_WRITE_BACK_MODES = [AGENT_WRITE_BACK_SUMMARY, AGENT_WRITE_BACK_PATCH] as const;
const AGENT_SPAWN_ISOLATION_MODES = [
  AGENT_WORKSPACE_SAME_WORKSPACE,
  AGENT_WORKSPACE_WORKTREE,
] as const;
const CHILD_PROGRESS_ERROR_MAX_CHARS = 1_000;

/**
 * Which schema fields each `agent_output` locator needs. A rejection that only
 * says "its matching identity fields" leaves the model guessing which of the
 * four optional id fields to add, so name them.
 */
const LOCATOR_REQUIRED_FIELDS = {
  child_session_latest: 'child_session_id',
  child_session_run: 'child_session_id and run_id',
  legacy_run: 'run_id',
  legacy_turn: 'turn_id',
} as const satisfies Record<string, string>;

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
  return out;
}

export function buildSubagentSpawnTool(
  deps: { taskLedger?: TaskLedgerStore; definitions?: readonly AgentDefinition[] } = {},
): MakaTool<
  {
    profile?: string;
    subagent_id?: string;
    task: string;
    write_back?: string;
    isolation?: string;
    task_id?: string;
  },
  unknown
> {
  const definitions = deps.definitions ?? BUILTIN_AGENT_DEFINITIONS;
  const profiles = agentProfilesForDefinitions(definitions);
  return {
    name: AGENT_SPAWN_TOOL_NAME,
    displayName: 'Agent',
    description:
      'Run one bounded foreground child task. Prefer agent_list, then select the user-approved subagent_id whose description fits the task; profile is retained for legacy callers.',
    parameters: z
      .object({
        profile: z.enum(profiles).optional().describe('Legacy child capability profile.'),
        subagent_id: z
          .string()
          .min(1)
          .max(128)
          .refine(isSafeSubagentPresetId)
          .optional()
          .describe('User-approved subagent preset id from agent_list.'),
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
        if (Boolean(input.profile) === Boolean(input.subagent_id)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'Provide exactly one of subagent_id or legacy profile.',
          });
          return;
        }
        if (!input.profile) return;
        const definition = requireAgentDefinitionByProfile(definitions, input.profile);
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
    nesting: 'direct_only',
    impl: async (input, ctx) => {
      const definition = input.profile
        ? requireAgentDefinitionByProfile(definitions, input.profile)
        : await resolvePresetDefinition(input.subagent_id!, ctx, definitions);
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
        throw new Error(
          'agent_spawn is not available in this session, so no child agent was started. ' +
            'Retrying agent_spawn will fail the same way — do the task yourself with the tools you already have.',
          {
            cause: new Error('spawnChildSession capability is unavailable in this runtime context'),
          },
        );
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
        result = projectSubagentToolResult(
          await ctx.spawnChildSession({
            agentProfile: definition.profile,
            ...(input.subagent_id ? { subagentId: input.subagent_id } : {}),
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
          }),
        );
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

async function resolvePresetDefinition(
  subagentId: string,
  ctx: MakaToolContext,
  definitions: readonly AgentDefinition[],
): Promise<AgentDefinition> {
  if (!ctx.listChildAgents) {
    throw new Error('listChildAgents capability is unavailable in this runtime context');
  }
  const catalog = await ctx.listChildAgents();
  if (!catalog || typeof catalog !== 'object' || Array.isArray(catalog)) {
    throw new Error('agent_list returned an invalid catalog');
  }
  const presets = (catalog as { presets?: unknown }).presets;
  if (!Array.isArray(presets)) throw new Error('Configured subagent catalog is unavailable');
  const preset = presets.find(
    (candidate): candidate is { id: string; profile: string; availability?: { status?: string } } =>
      Boolean(candidate) &&
      typeof candidate === 'object' &&
      !Array.isArray(candidate) &&
      (candidate as { id?: unknown }).id === subagentId &&
      typeof (candidate as { profile?: unknown }).profile === 'string',
  );
  if (!preset) throw new Error(`Unknown subagent_id "${subagentId}". Call agent_list first.`);
  if (preset.availability?.status !== 'available') {
    throw new Error(`Subagent preset "${subagentId}" is unavailable.`);
  }
  return requireAgentDefinitionByProfile(definitions, preset.profile);
}

function projectSubagentToolResult(value: unknown): Omit<SubagentToolResult, 'kind'> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Child agent returned an invalid result');
  }
  const raw = value as Record<string, unknown>;
  const decoded = decodeCanonicalToolResultContent({
    kind: 'subagent',
    ...(raw.childSessionId !== undefined ? { childSessionId: raw.childSessionId } : {}),
    ...(raw.agentId !== undefined ? { agentId: raw.agentId } : {}),
    agentName: raw.agentName,
    turnId: raw.turnId,
    ...(raw.runId !== undefined ? { runId: raw.runId } : {}),
    status: raw.status,
    permissionMode: raw.permissionMode,
    summary: raw.summary,
    artifactIds: raw.artifactIds,
    ...(raw.startedAt !== undefined ? { startedAt: raw.startedAt } : {}),
    ...(raw.completedAt !== undefined ? { completedAt: raw.completedAt } : {}),
    ...(raw.durationMs !== undefined ? { durationMs: raw.durationMs } : {}),
    ...(raw.eventCount !== undefined ? { eventCount: raw.eventCount } : {}),
    ...(raw.failureClass !== undefined ? { failureClass: raw.failureClass } : {}),
  });
  if (decoded.kind !== 'subagent') throw new Error('Child agent returned an invalid result');
  const { kind: _kind, ...result } = decoded as SubagentToolResult;
  return result;
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
      'List user-approved subagent presets (including task descriptions, model routes, and availability), capability definitions, and child runs for this session.',
    parameters: z.object({}),
    categoryHint: 'read',
    nesting: 'direct_only',
    impl: async (_input, ctx) => {
      // Not reachable from the desktop app or the CLI: both pass
      // `listChildAgents` to ToolRuntime unconditionally
      // (`session-stream.ts`, `runtime-bootstrap.ts`), and ToolRuntime hands
      // it straight to the tool context. `harbor-cell.ts` passes it only when
      // its own context carries one, so a headless embedder can still land
      // here — which is why this stays a sentence rather than being deleted.
      if (!ctx.listChildAgents) {
        throw new Error(
          'agent_list is not available in this session, so no agent catalog or child run list could be read. ' +
            'Retrying agent_list will fail the same way — pick a child agent profile from the agent_spawn schema instead.',
          { cause: new Error('listChildAgents capability is unavailable in this runtime context') },
        );
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
              message: `locator=${input.locator} requires ${LOCATOR_REQUIRED_FIELDS[input.locator]}.`,
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
    nesting: 'direct_only',
    impl: async (input, ctx) => {
      if (!ctx.readChildAgentOutput) {
        // Same reachability as `agent_list` above.
        throw new Error(
          'agent_output is not available in this session, so no child output could be read. ' +
            'Retrying agent_output will fail the same way — use the summary the agent_spawn or agent_swarm call already returned for that child.',
          {
            cause: new Error(
              'readChildAgentOutput capability is unavailable in this runtime context',
            ),
          },
        );
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

export function buildParentAgentTools(
  deps: { taskLedger?: TaskLedgerStore; definitions?: readonly AgentDefinition[] } = {},
): MakaTool[] {
  const definitions = deps.definitions ?? BUILTIN_AGENT_DEFINITIONS;
  return [
    ...(definitions.length > 0
      ? [buildSubagentSpawnTool({ ...deps, definitions }), buildAgentSwarmTool({ definitions })]
      : []),
    ...buildSubagentProjectionTools(),
  ];
}
