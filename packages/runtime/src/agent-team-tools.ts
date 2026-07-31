import { z } from 'zod';
import {
  AGENT_MAILBOX_CONTENT_MAX_CHARS,
  AGENT_MAILBOX_LIST_MAX,
  TASK_ID_MAX_CHARS,
  filterModelVisibleTaskLedgerTasks,
  isSafeTaskId,
  sanitizeTaskLedgerTask,
  type AgentMailboxParticipantRef,
  type AgentMailboxStore,
  type TaskLedgerStore,
} from '@maka/core';
import { buildExpertAgentId, getExpertTeam } from './expert-catalog.js';
import type { AgentTeamExecutionContext, MakaTool, MakaToolContext } from './tool-runtime.js';
import {
  AGENT_TEAM_CHILD_TOOL_NAMES,
  AGENT_TEAM_LEAD_TOOL_NAMES,
  TEAM_INBOX_TOOL_NAME,
  TEAM_MESSAGE_TOOL_NAME,
  TEAM_TASK_CLAIM_TOOL_NAME,
  TEAM_TASK_LIST_TOOL_NAME,
} from './agent-team-tool-names.js';

export interface AgentTeamToolDeps {
  mailbox: AgentMailboxStore;
  taskLedger: TaskLedgerStore;
}

export function buildAgentTeamLeadTools(deps: AgentTeamToolDeps): MakaTool[] {
  const all = buildAgentTeamTools(deps);
  const names = new Set<string>(AGENT_TEAM_LEAD_TOOL_NAMES);
  return all.filter((tool) => names.has(tool.name));
}

export function buildAgentTeamChildTools(deps: AgentTeamToolDeps): MakaTool[] {
  const all = buildAgentTeamTools(deps);
  const names = new Set<string>(AGENT_TEAM_CHILD_TOOL_NAMES);
  return all.filter((tool) => names.has(tool.name));
}

export function buildAgentTeamTools(deps: AgentTeamToolDeps): MakaTool[] {
  return [
    buildTeamMessageTool(deps.mailbox),
    buildTeamInboxTool(deps.mailbox),
    buildTeamTaskListTool(deps.taskLedger),
    buildTeamTaskClaimTool(deps.taskLedger),
  ];
}

function buildTeamMessageTool(mailbox: AgentMailboxStore): MakaTool {
  return {
    name: TEAM_MESSAGE_TOOL_NAME,
    displayName: 'Team Message',
    description:
      'Send one bounded, durable message to the team lead role, a member role mailbox, or the whole current expert-team run.',
    parameters: z.discriminatedUnion('type', [
      z.object({
        type: z.literal('message'),
        recipient: z
          .string()
          .min(1)
          .max(128)
          .describe(
            'Use "lead" or a member id from the team roster. A member id addresses its shared role mailbox.',
          ),
        content: z.string().min(1).max(AGENT_MAILBOX_CONTENT_MAX_CHARS),
      }),
      z.object({
        type: z.literal('broadcast'),
        content: z.string().min(1).max(AGENT_MAILBOX_CONTENT_MAX_CHARS),
      }),
    ]),
    categoryHint: 'read',
    impl: async (input: unknown, ctx) => {
      const execution = requireAgentTeamExecution(ctx);
      const parsed = input as {
        type: 'message' | 'broadcast';
        recipient?: string;
        content: string;
      };
      const from = participantFromContext(execution, ctx);
      const to =
        parsed.type === 'message' ? resolveRecipient(execution, parsed.recipient) : undefined;
      return await mailbox.send(ctx.sessionId, {
        teamId: execution.teamId,
        parentRunId: parentRunIdFor(execution, ctx),
        kind: parsed.type,
        from,
        ...(to ? { to } : {}),
        content: parsed.content,
      });
    },
  };
}

function buildTeamInboxTool(mailbox: AgentMailboxStore): MakaTool {
  return {
    name: TEAM_INBOX_TOOL_NAME,
    displayName: 'Team Inbox',
    description:
      'Read durable direct messages and teammate broadcasts for this role in the current expert-team run. ' +
      'Repeated or concurrent invocations of one member share this history; each caller must pass its own after_seq cursor.',
    parameters: z.object({
      after_seq: z.number().int().min(0).optional(),
      limit: z.number().int().min(1).max(AGENT_MAILBOX_LIST_MAX).optional(),
    }),
    categoryHint: 'read',
    impl: async (input: unknown, ctx) => {
      const execution = requireAgentTeamExecution(ctx);
      const parsed = input as { after_seq?: number; limit?: number };
      return await mailbox.list(ctx.sessionId, {
        teamId: execution.teamId,
        parentRunId: parentRunIdFor(execution, ctx),
        recipientAgentId: execution.agentId,
        ...(parsed.after_seq !== undefined ? { afterSeq: parsed.after_seq } : {}),
        ...(parsed.limit !== undefined ? { limit: parsed.limit } : {}),
      });
    },
  };
}

function buildTeamTaskListTool(taskLedger: TaskLedgerStore): MakaTool {
  return {
    name: TEAM_TASK_LIST_TOOL_NAME,
    displayName: 'Team Tasks',
    description:
      'List Task Ledger items shared by the current lead AgentRun and eligible for atomic child self-claim.',
    parameters: z.object({}),
    categoryHint: 'read',
    impl: async (_input, ctx) => {
      const execution = requireMemberExecution(ctx);
      const tasks = filterModelVisibleTaskLedgerTasks(
        await taskLedger.list(ctx.sessionId, {
          includeTerminal: false,
          classifyResumeTrust: true,
        }),
      )
        .filter(
          (task) =>
            (task.status === 'pending' || task.status === 'blocked') &&
            task.owner?.actor === 'main_agent' &&
            task.owner.runId === execution.parentRunId,
        )
        .map((task) => {
          const safe = sanitizeTaskLedgerTask(task);
          return {
            id: safe.id,
            key: safe.key,
            subject: safe.subject,
            status: safe.status,
            ...(safe.parentId ? { parentId: safe.parentId } : {}),
            ...(safe.blockedReason ? { blockedReason: safe.blockedReason } : {}),
          };
        });
      return { tasks, total: tasks.length };
    },
  };
}

function buildTeamTaskClaimTool(taskLedger: TaskLedgerStore): MakaTool {
  return {
    name: TEAM_TASK_CLAIM_TOOL_NAME,
    displayName: 'Claim Team Task',
    description:
      'Atomically claim one available shared Task Ledger item for this child turn. This grants work ownership, never completion authority.',
    parameters: z.object({
      task_id: z
        .string()
        .min(1)
        .max(TASK_ID_MAX_CHARS)
        .refine(isSafeTaskId)
        .describe('Task UUID or short key from team_task_list.'),
    }),
    categoryHint: 'read',
    impl: async (input: unknown, ctx) => {
      const execution = requireMemberExecution(ctx);
      const parsed = input as { task_id: string };
      const owner = {
        actor: 'child_agent' as const,
        agentId: execution.agentId,
        runId: requireRunId(ctx),
        turnId: ctx.turnId,
      };
      const result = await taskLedger.claimAvailable(
        ctx.sessionId,
        parsed.task_id,
        owner,
        {
          parentRunId: execution.parentRunId,
        },
        {
          runId: owner.runId,
          turnId: owner.turnId,
          toolCallId: ctx.toolCallId,
          source: 'tool',
          actor: 'child_agent',
          reason: `self-claimed by expert team member ${execution.agentId}`,
        },
      );
      return { task: sanitizeTaskLedgerTask(result.updated), total: result.total };
    },
  };
}

function requireAgentTeamExecution(ctx: MakaToolContext): AgentTeamExecutionContext {
  if (!ctx.agentTeam)
    throw new Error('Agent team capability is unavailable outside an expert-team run');
  requireRunId(ctx);
  if (ctx.agentTeam.role === 'member' && !ctx.agentTeam.parentRunId) {
    throw new Error('Expert-team member is missing its parent AgentRun identity');
  }
  return ctx.agentTeam;
}

function requireMemberExecution(
  ctx: MakaToolContext,
): AgentTeamExecutionContext & { role: 'member'; parentRunId: string } {
  const execution = requireAgentTeamExecution(ctx);
  if (execution.role !== 'member' || !execution.parentRunId) {
    throw new Error('Shared task self-claim is available only to expert-team members');
  }
  return execution as AgentTeamExecutionContext & { role: 'member'; parentRunId: string };
}

function requireRunId(ctx: MakaToolContext): string {
  if (!ctx.runId) throw new Error('Agent team tool requires a durable AgentRun identity');
  return ctx.runId;
}

function parentRunIdFor(execution: AgentTeamExecutionContext, ctx: MakaToolContext): string {
  return execution.role === 'lead' ? requireRunId(ctx) : execution.parentRunId!;
}

function participantFromContext(
  execution: AgentTeamExecutionContext,
  ctx: MakaToolContext,
): AgentMailboxParticipantRef {
  return {
    role: execution.role,
    agentId: execution.agentId,
    runId: requireRunId(ctx),
    turnId: ctx.turnId,
  };
}

function resolveRecipient(
  execution: AgentTeamExecutionContext,
  recipient: string | undefined,
): { role: 'lead' | 'member'; agentId: string } {
  if (!recipient) throw new Error('Direct team messages require a recipient');
  if (recipient === 'lead') {
    if (execution.role === 'lead') throw new Error('Team messages cannot target the sender');
    return { role: 'lead', agentId: 'lead' };
  }
  const team = getExpertTeam(execution.teamId);
  const member = team?.members.find((candidate) => candidate.id === recipient);
  if (!team || !member)
    throw new Error(`Unknown member "${recipient}" for expert team "${execution.teamId}"`);
  const agentId = buildExpertAgentId(team.id, member.id);
  if (agentId === execution.agentId) throw new Error('Team messages cannot target the sender');
  return { role: 'member', agentId };
}
