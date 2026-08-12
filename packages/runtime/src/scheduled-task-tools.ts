/**
 * Agent tool for the unified ScheduledTask catalog.
 *
 * Agent-facing access to the Runtime Host-owned ScheduledTask catalog.
 */

import { z } from 'zod';
import {
  SCHEDULED_TASK_CRON_MAX_CHARS,
  SCHEDULED_TASK_INTENT_MAX_CHARS,
  SCHEDULED_TASK_MAX_INTERVAL_SECONDS,
  SCHEDULED_TASK_TITLE_MAX_CHARS,
  type ScheduledTask,
  type ScheduledTaskExecutionTemplate,
} from '@maka/core/scheduled-task';
import type { MakaTool } from './tool-runtime.js';

export const SCHEDULED_TASK_TOOL_NAME = 'ScheduledTask';
export const SCHEDULED_TASK_NATIVE_EFFECT_SERVICE_ID = 'maka_scheduled_task_native_effect';
export const SCHEDULED_TASK_NATIVE_EFFECT_SERVICE_VERSION = '1';

export interface ScheduledTaskToolAuthority {
  create(input: {
    title: string;
    intentBody: string;
    schedule:
      | { kind: 'once'; runAt: number }
      | { kind: 'interval'; everySeconds: number; startAt?: number }
      | { kind: 'cron'; expression: string; startAt?: number };
    effect: 'session_resume' | 'agent_run' | 'notify_local';
    sessionId: string;
    maxFires?: number;
  }): Promise<ScheduledTask | { error: string }>;
  list(): Promise<readonly ScheduledTask[]>;
  pause(id: string): Promise<ScheduledTask | { error: string }>;
  resume(id: string): Promise<ScheduledTask | { error: string }>;
  remove(id: string): Promise<{ ok: true } | { error: string }>;
}

const scheduleSchema = z.union([
  z.object({
    kind: z.literal('once'),
    runAt: z.number().int().positive(),
  }),
  z.object({
    kind: z.literal('interval'),
    everySeconds: z.number().int().min(10).max(SCHEDULED_TASK_MAX_INTERVAL_SECONDS),
    startAt: z.number().int().positive().optional(),
  }),
  z.object({
    kind: z.literal('cron'),
    expression: z.string().min(9).max(SCHEDULED_TASK_CRON_MAX_CHARS),
    startAt: z.number().int().positive().optional(),
  }),
]);

const schema = z.object({
  mode: z
    .enum(['create', 'list', 'pause', 'resume', 'delete'])
    .describe('create / list / pause / resume / delete a scheduled task'),
  title: z.string().trim().min(1).max(SCHEDULED_TASK_TITLE_MAX_CHARS).optional(),
  intentBody: z
    .string()
    .trim()
    .min(1)
    .max(SCHEDULED_TASK_INTENT_MAX_CHARS)
    .optional()
    .describe('[create] Work description or agent prompt to run when due'),
  schedule: scheduleSchema.optional(),
  effect: z
    .enum(['session_resume', 'agent_run', 'notify_local'])
    .optional()
    .describe(
      '[create] session_resume (default) resumes this conversation; agent_run starts a fresh session; notify_local only shows a local notification',
    ),
  id: z.string().min(1).optional().describe('[pause|resume|delete] task id'),
  maxFires: z.number().int().min(1).max(10_000).optional(),
});

export function buildScheduledTaskTool(deps: { authority: ScheduledTaskToolAuthority }): MakaTool {
  return {
    name: SCHEDULED_TASK_TOOL_NAME,
    displayName: 'ScheduledTask',
    description:
      'Create and manage global scheduled tasks (定时任务). ' +
      'Use for every recurring or one-shot task. All tasks appear in the desktop Scheduled tasks page. ' +
      'The default session_resume effect continues this conversation; use agent_run for independent work.',
    parameters: schema,
    impl: async (raw, ctx) => {
      const input = schema.parse(raw);
      const sessionId = ctx.sessionId;
      if (input.mode === 'list') {
        const tasks = await deps.authority.list();
        if (tasks.length === 0) return 'No scheduled tasks.';
        return tasks
          .map(
            (task) =>
              `- ${task.id} | ${task.title} | ${task.status} | next=${task.nextFireAt ?? '—'} | effect=${task.effect.kind}`,
          )
          .join('\n');
      }
      if (input.mode === 'create') {
        if (!input.title || !input.intentBody || !input.schedule) {
          return 'create requires title, intentBody, and schedule';
        }
        const result = await deps.authority.create({
          title: input.title,
          intentBody: input.intentBody,
          schedule: input.schedule,
          effect: input.effect ?? 'session_resume',
          sessionId,
          ...(input.maxFires !== undefined ? { maxFires: input.maxFires } : {}),
        });
        if ('error' in result) return result.error;
        return `Scheduled task created: ${result.title} (${result.id})\nnextFireAt=${result.nextFireAt}\neffect=${result.effect.kind}`;
      }
      if (!input.id) return `${input.mode} requires id`;
      if (input.mode === 'pause') {
        const result = await deps.authority.pause(input.id);
        if ('error' in result) return result.error;
        return `Paused ${result.title} (${result.id})`;
      }
      if (input.mode === 'resume') {
        const result = await deps.authority.resume(input.id);
        if ('error' in result) return result.error;
        return `Resumed ${result.title} (${result.id})`;
      }
      const result = await deps.authority.remove(input.id);
      if ('error' in result) return result.error;
      return `Deleted scheduled task ${input.id}`;
    },
  };
}

/** Build create payload for the SQLite store from tool + session execution snapshot. */
export function buildAgentScheduledTaskCreatePayload(input: {
  title: string;
  intentBody: string;
  schedule:
    | { kind: 'once'; runAt: number }
    | { kind: 'interval'; everySeconds: number; startAt?: number }
    | { kind: 'cron'; expression: string; startAt?: number };
  effect: 'session_resume' | 'agent_run' | 'notify_local';
  sessionId: string;
  execution?: ScheduledTaskExecutionTemplate;
  maxFires?: number;
  now?: number;
}):
  | {
      title: string;
      intentBody: string;
      schedule: ScheduledTask['schedule'];
      effect: ScheduledTask['effect'];
      createdBy: ScheduledTask['createdBy'];
      maxFires?: number;
    }
  | { error: string } {
  const now = input.now ?? Date.now();
  if (input.effect === 'agent_run' && !input.execution) {
    return { error: 'agent_run requires a frozen execution template from the creator session' };
  }
  const schedule =
    input.schedule.kind === 'once'
      ? input.schedule
      : input.schedule.kind === 'interval'
        ? {
            kind: 'interval' as const,
            everySeconds: input.schedule.everySeconds,
            startAt: input.schedule.startAt ?? now,
          }
        : {
            kind: 'cron' as const,
            expression: input.schedule.expression,
            startAt: input.schedule.startAt ?? now,
          };
  if (input.effect === 'agent_run') {
    return {
      title: input.title,
      intentBody: input.intentBody,
      schedule,
      effect: { kind: 'agent_run', execution: input.execution! },
      createdBy: { kind: 'agent', sessionId: input.sessionId },
      ...(input.maxFires !== undefined ? { maxFires: input.maxFires } : {}),
    };
  }
  if (input.effect === 'session_resume') {
    return {
      title: input.title,
      intentBody: input.intentBody,
      schedule,
      effect: { kind: 'session_resume', sessionId: input.sessionId },
      createdBy: { kind: 'agent', sessionId: input.sessionId },
      ...(input.maxFires !== undefined ? { maxFires: input.maxFires } : {}),
    };
  }
  return {
    title: input.title,
    intentBody: input.intentBody,
    schedule,
    effect: { kind: 'notify', channel: 'local' },
    createdBy: { kind: 'agent', sessionId: input.sessionId },
    ...(input.maxFires !== undefined ? { maxFires: input.maxFires } : {}),
  };
}
