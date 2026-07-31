/**
 * The `expert_dispatch` tool — a team lead's fan-out primitive.
 *
 * Available only in an expert-team session (`mode:expert-team:<teamId>`), this
 * tool lets the lead dispatch a member expert as a tool-scoped child agent. It
 * is a thin, team-bound wrapper over the same `spawnChildAgent` capability the
 * built-in `agent_spawn` tool uses: the member id (`expert:<teamId>:<memberId>`)
 * resolves to a materialized child definition whose tool scope, permission
 * mode, and system prompt are enforced by the child-turn machinery.
 *
 * Parallel fan-out is the runtime's existing primitive: the lead emits several
 * `expert_dispatch` calls in one turn and they run concurrently (distinct child
 * turns, no shared mutex). Fan-in is the child result's bounded `summary` plus
 * `artifactIds` pointers — members return digests, not raw payloads.
 */

import { z } from 'zod';
import type { TaskAgentOutcome, TaskLedgerStore, TaskOwner, ToolResultContent } from '@maka/core';
import type { MakaTool } from './tool-runtime.js';
import {
  type ExpertTeamDefinition,
  buildExpertAgentId,
  buildExpertTeamMemberRoster,
  getExpertTeam,
  materializeExpertAgentDefinition,
} from './expert-catalog.js';

export const EXPERT_DISPATCH_TOOL_NAME = 'expert_dispatch';

type SubagentToolResult = Extract<ToolResultContent, { kind: 'subagent' }>;

export interface ExpertDispatchToolDeps {
  taskLedger?: TaskLedgerStore;
}

function memberEnum(team: ExpertTeamDefinition): [string, ...string[]] {
  const ids = team.members.map((member) => member.id);
  return [ids[0]!, ...ids.slice(1)];
}

/**
 * Build the `expert_dispatch` tool bound to a specific team. The member enum and
 * the roster embedded in the description are the team's members, so the model
 * can only dispatch valid members and sees each member's lens and tool scope.
 */
export function buildExpertDispatchTool(
  team: ExpertTeamDefinition,
  deps: ExpertDispatchToolDeps = {},
): MakaTool<
  {
    member: string;
    task: string;
  },
  unknown
> {
  const roster = buildExpertTeamMemberRoster(team);
  return {
    name: EXPERT_DISPATCH_TOOL_NAME,
    displayName: 'Expert Dispatch',
    description: [
      `Dispatch a member of the "${team.name}" to a bounded task and return its result.`,
      'The member runs as a tool-scoped child agent with its own fresh context — it sees only the task you pass, so make each task self-contained (exact files/scope + what to look for).',
      'Run members concurrently by emitting several expert_dispatch calls in a single turn. Members may exchange bounded mailbox messages, but you remain responsible for synthesis and final task completion.',
      '',
      'Members:',
      roster,
    ].join('\n'),
    parameters: z.object({
      member: z.enum(memberEnum(team)).describe('The team member to dispatch.'),
      task: z
        .string()
        .min(1)
        .max(60_000)
        .describe(
          'The bounded, self-contained task for the member, including the exact scope and evidence to return.',
        ),
    }),
    categoryHint: 'subagent',
    impl: async (input, ctx) => {
      const member = team.members.find((entry) => entry.id === input.member);
      if (!member) {
        // Unreachable via the enum, but keep a precise error if the schema is bypassed.
        throw new Error(`Unknown member "${input.member}" for expert team "${team.id}".`);
      }
      if (!ctx.spawnChildAgent) {
        throw new Error('spawnChildAgent capability is unavailable in this runtime context');
      }
      const definition = materializeExpertAgentDefinition(team, member);
      let ready: { turnId: string; agentId: string } | undefined;
      let result: Omit<SubagentToolResult, 'kind'>;
      try {
        result = (await ctx.spawnChildAgent({
          spec: {
            id: buildExpertAgentId(team.id, member.id),
            name: definition.name,
            systemPrompt: definition.systemPrompt,
          },
          prompt: input.task,
          ...(deps.taskLedger
            ? {
                onReady: ({ turnId, agentId }) => {
                  ready = { turnId, agentId };
                },
              }
            : {}),
        })) as Omit<SubagentToolResult, 'kind'>;
      } catch (error) {
        if (deps.taskLedger && ready) {
          await settleSelfClaimedTasks(
            deps.taskLedger,
            ctx.sessionId,
            ready,
            {
              status: 'failed',
              reason:
                error instanceof Error
                  ? error.message
                  : 'Expert-team member failed before returning a result',
            },
            ctx.toolCallId,
          );
        }
        throw error;
      }
      if (deps.taskLedger && ready) {
        await settleSelfClaimedTasks(
          deps.taskLedger,
          ctx.sessionId,
          ready,
          {
            status: result.status,
            ...(result.runId ? { runId: result.runId } : {}),
            reason: result.failureClass ?? result.summary,
          },
          ctx.toolCallId,
        );
      }
      return {
        kind: 'subagent',
        ...result,
      } satisfies SubagentToolResult;
    },
  };
}

/** Build the dispatch tool for a team id, or `undefined` if the team is unknown. */
export function buildExpertDispatchToolForTeamId(
  teamId: string,
  deps: ExpertDispatchToolDeps = {},
): MakaTool | undefined {
  const team = getExpertTeam(teamId);
  return team ? (buildExpertDispatchTool(team, deps) as MakaTool) : undefined;
}

async function settleSelfClaimedTasks(
  taskLedger: TaskLedgerStore,
  sessionId: string,
  ready: { turnId: string; agentId: string },
  result: { status: TaskAgentOutcome['status']; runId?: string; reason?: string },
  toolCallId: string,
): Promise<void> {
  const claimed = (await taskLedger.list(sessionId, { includeTerminal: false })).filter(
    (task) =>
      task.owner?.actor === 'child_agent' &&
      task.owner.agentId === ready.agentId &&
      task.owner.turnId === ready.turnId,
  );
  for (const task of claimed) {
    const runId = result.runId ?? task.owner?.runId;
    const owner: TaskOwner = {
      actor: 'child_agent',
      agentId: ready.agentId,
      ...(runId ? { runId } : {}),
      turnId: ready.turnId,
    };
    await taskLedger.settleAgentOutcome(
      sessionId,
      task.id,
      {
        status: result.status,
        owner,
        reason: result.reason,
      },
      {
        runId,
        turnId: ready.turnId,
        toolCallId,
        source: 'system',
        actor: 'child_agent',
        reason: result.reason,
      },
    );
  }
}
