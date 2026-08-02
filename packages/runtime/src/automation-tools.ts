/**
 * Unified Automation tool — single tool with mode parameter.
 *
 * Modes: create, delete, list, pause, resume
 * Kinds: heartbeat (session-internal polling) | cron (standalone scheduled runs)
 *
 * Follows Codex Desktop's pattern: one tool, parameters decide behavior.
 */

import { z } from 'zod';
import {
  AUTOMATION_CRON_EXPRESSION_LIMIT,
  AUTOMATION_CRON_EXPRESSION_MAX_CODE_UNITS,
  AUTOMATION_NAME_LIMIT,
  AUTOMATION_NAME_MAX_CODE_UNITS,
  AUTOMATION_PROMPT_LIMIT,
  AUTOMATION_PROMPT_MAX_CODE_UNITS,
  isAutomationTextWithinLimit,
} from '@maka/core/automation';
import type { MakaTool } from './tool-runtime.js';
import type { AutomationManager, AutomationDefinition } from './automation-state.js';

export const AUTOMATION_TOOL_NAME = 'Automation';
export const AUTOMATION_MODEL_LIST_MAX_ITEMS = 100;

export interface AutomationToolDeps {
  automationManager: AutomationManager;
  onAutomationChange?: () => void;
  /** Whether the host can run cron (fresh-session) automations. When false, the
   *  cron kind is not advertised and is rejected at creation. */
  cronEnabled?: boolean;
}

export interface AutomationToolAuthority {
  create(input: {
    kind: AutomationDefinition['kind'];
    name: string;
    prompt: string;
    sessionId: string;
    schedule: AutomationDefinition['schedule'];
    maxFires?: number;
    durable?: boolean;
  }): Promise<AutomationDefinition | { error: string }>;
  delete(id: string, sessionId: string): Promise<boolean>;
  pause(id: string, sessionId: string): Promise<AutomationDefinition | undefined>;
  resume(id: string, sessionId: string): Promise<AutomationDefinition | undefined>;
  get(id: string, sessionId: string): Promise<AutomationDefinition | undefined>;
  listVisibleForSession(sessionId: string): Promise<readonly AutomationDefinition[]>;
}

export interface AutomationAuthorityToolDeps {
  readonly authority: AutomationToolAuthority;
  readonly cronEnabled?: boolean;
}

const scheduleSchema = z.union([
  z.object({
    type: z.literal('cron'),
    expression: z
      .string()
      .min(9)
      .max(AUTOMATION_CRON_EXPRESSION_MAX_CODE_UNITS)
      .refine((value) => isAutomationTextWithinLimit(value, AUTOMATION_CRON_EXPRESSION_LIMIT), {
        message: 'Cron expression exceeds the Automation text limit.',
      })
      .describe(
        '5-field cron expression: "minute hour day-of-month month day-of-week". Example: "*/5 * * * *" = every 5 min, "0 9 * * 1-5" = weekdays at 9am.',
      ),
  }),
  z.object({
    type: z.literal('interval'),
    seconds: z
      .number()
      .int()
      .min(10)
      .max(86400)
      .describe('Repeat interval in seconds (10s to 24h).'),
  }),
  z.object({
    type: z.literal('once'),
    delay_seconds: z
      .number()
      .int()
      .min(5)
      .max(86400)
      .describe('One-shot delay in seconds (5s to 24h). Fires once then auto-completes.'),
  }),
]);

// A SINGLE top-level object schema (Anthropic tool input_schema.type must be
// "object" — a discriminated union serializes as anyOf with no top-level type
// and the API rejects it). Per-mode fields are optional here and validated in
// impl(). mode selects the operation.
function makeAutomationSchema(kindSchema: z.ZodType) {
  return z.object({
    mode: z
      .enum(['create', 'delete', 'list', 'pause', 'resume'])
      .describe(
        "Operation: create a new automation, delete/pause/resume one by id, or list this session's automations.",
      ),
    kind: kindSchema.optional(),
    name: z
      .string()
      .trim()
      .min(1)
      .max(AUTOMATION_NAME_MAX_CODE_UNITS)
      .refine(
        (value) => isAutomationTextWithinLimit(value, AUTOMATION_NAME_LIMIT, { nonblank: true }),
        { message: 'Automation name exceeds the text limit.' },
      )
      .optional()
      .describe('[create] Short human-readable name.'),
    prompt: z
      .string()
      .trim()
      .min(1)
      .max(AUTOMATION_PROMPT_MAX_CODE_UNITS)
      .refine(
        (value) => isAutomationTextWithinLimit(value, AUTOMATION_PROMPT_LIMIT, { nonblank: true }),
        { message: 'Automation prompt exceeds the text limit.' },
      )
      .optional()
      .describe('[create] The prompt to execute on each fire.'),
    schedule: scheduleSchema
      .optional()
      .describe(
        '[create] When to fire. Use "interval" for simple repeats, "cron" for complex schedules, "once" for one-shot.',
      ),
    max_fires: z
      .number()
      .int()
      .min(1)
      .max(10000)
      .optional()
      .describe(
        '[create] Maximum fires before auto-completing. Omit for unlimited (7-day expiry still applies).',
      ),
    durable: z
      .boolean()
      .optional()
      .describe(
        '[create] When true, persists across app restarts. Cron defaults to true (standalone scheduled task); heartbeat defaults to false (bound to this session).',
      ),
    id: z.string().min(1).max(64).optional().describe('[delete/pause/resume] Automation id.'),
  });
}

const AUTOMATION_SCHEMA_WITH_CRON = makeAutomationSchema(
  z
    .enum(['heartbeat', 'cron'])
    .describe(
      '[create] heartbeat = resume into current session (polling/monitoring). cron = create fresh session each run (standalone scheduled tasks).',
    ),
);
const AUTOMATION_SCHEMA_HEARTBEAT_ONLY = makeAutomationSchema(
  z
    .enum(['heartbeat'])
    .describe(
      '[create] heartbeat = resume into current session. This host supports heartbeat only.',
    ),
);

// Type from the broadest (cron-enabled) schema so kind can be 'heartbeat'|'cron'.
type AutomationInput = z.infer<typeof AUTOMATION_SCHEMA_WITH_CRON>;

export function buildAutomationTool(deps: AutomationToolDeps): MakaTool<AutomationInput, string> {
  const changed = <T>(value: T): T => {
    deps.onAutomationChange?.();
    return value;
  };
  return buildAutomationAuthorityTool({
    cronEnabled: deps.cronEnabled,
    authority: {
      create: async (input) => changed(deps.automationManager.create(input)),
      delete: async (id, sessionId) => changed(deps.automationManager.delete(id, sessionId)),
      pause: async (id, sessionId) => changed(deps.automationManager.pause(id, sessionId)),
      resume: async (id, sessionId) => changed(deps.automationManager.resume(id, sessionId)),
      get: async (id, sessionId) => {
        const automation = deps.automationManager.get(id);
        return automation && (automation.sessionId === sessionId || automation.durable === true)
          ? automation
          : undefined;
      },
      listVisibleForSession: async (sessionId) =>
        deps.automationManager.listVisibleForSession(sessionId),
    },
  });
}

export function buildAutomationAuthorityTool(
  deps: AutomationAuthorityToolDeps,
): MakaTool<AutomationInput, string> {
  const cronEnabled = deps.cronEnabled === true;
  return {
    name: AUTOMATION_TOOL_NAME,
    displayName: 'Automation',
    description:
      'Create, manage, and list recurring automations. ' +
      'Use kind "heartbeat" for session-internal polling (resumes into this conversation). ' +
      (cronEnabled
        ? 'Use kind "cron" for standalone scheduled tasks (creates a fresh session each run). '
        : '') +
      'Automations auto-expire after 7 days unless deleted earlier.',
    parameters: cronEnabled ? AUTOMATION_SCHEMA_WITH_CRON : AUTOMATION_SCHEMA_HEARTBEAT_ONLY,
    impl: async (input, ctx) => {
      let result: string;
      switch (input.mode) {
        case 'create':
          result = await handleCreate(deps.authority, input, ctx.sessionId, cronEnabled);
          break;
        case 'delete':
          result = await handleById(input, async (id) =>
            (await deps.authority.delete(id, ctx.sessionId))
              ? `Automation "${id}" deleted.`
              : `Automation "${id}" not found or not owned by this session.`,
          );
          break;
        case 'list':
          return handleList(deps.authority, ctx.sessionId);
        case 'pause': {
          result = await handleById(input, async (id) => {
            const r = await deps.authority.pause(id, ctx.sessionId);
            return r
              ? `Automation "${r.name}" paused. Use mode "resume" to reactivate.`
              : `Cannot pause "${id}": not found, not owned, or not active.`;
          });
          break;
        }
        case 'resume': {
          result = await handleById(input, async (id) => {
            const r = await deps.authority.resume(id, ctx.sessionId);
            if (r) {
              return `Automation "${r.name}" resumed. Next fire: ${r.nextFireAt ? new Date(r.nextFireAt).toLocaleString() : 'N/A'}`;
            }
            // Distinguish a spent fire budget from other resume failures so the
            // agent doesn't keep retrying a cap that can never be revived.
            const existing = await deps.authority.get(id, ctx.sessionId);
            if (existing && existing.status === 'paused') {
              const spent =
                (existing.maxFires != null && existing.fireCount >= existing.maxFires) ||
                (existing.schedule.type === 'once' && existing.fireCount > 0);
              if (spent) {
                return `Cannot resume "${id}": its fire budget is exhausted (fired ${existing.fireCount}${existing.maxFires != null ? `/${existing.maxFires}` : ''} time(s)). Create a new automation instead.`;
              }
            }
            return `Cannot resume "${id}": not found, not owned, or not paused.`;
          });
          break;
        }
      }
      return result;
    },
  };
}

async function handleById(
  input: AutomationInput,
  run: (id: string) => Promise<string>,
): Promise<string> {
  if (!input.id) return 'Error: "id" is required for delete/pause/resume.';
  return await run(input.id);
}

async function handleCreate(
  authority: AutomationToolAuthority,
  input: AutomationInput,
  sessionId: string,
  cronEnabled: boolean,
): Promise<string> {
  if (!input.kind) return 'Error: "kind" is required for create.';
  if (!input.name) return 'Error: "name" is required for create.';
  if (!input.prompt) return 'Error: "prompt" is required for create.';
  if (!input.schedule) return 'Error: "schedule" is required for create.';
  if (input.kind === 'cron' && !cronEnabled) {
    return 'Error: cron automations are not supported on this host. Use kind "heartbeat".';
  }
  const schedule =
    input.schedule.type === 'once'
      ? { type: 'once' as const, delaySeconds: input.schedule.delay_seconds }
      : input.schedule;

  const result = await authority.create({
    kind: input.kind as 'heartbeat' | 'cron',
    name: input.name,
    prompt: input.prompt,
    sessionId,
    schedule,
    maxFires: input.max_fires,
    durable: input.durable,
  });

  if ('error' in result) {
    return `Error: ${result.error}`;
  }

  const scheduleDesc = describeSchedule(result.schedule);
  return [
    `Automation created: "${result.name}" (${result.kind}${result.durable ? ', durable' : ''})`,
    `ID: ${result.id}`,
    `Schedule: ${scheduleDesc}`,
    `Next fire: ${result.nextFireAt ? new Date(result.nextFireAt).toLocaleString() : 'N/A'}`,
    result.kind === 'heartbeat'
      ? 'Fires into this session. Stops when session ends or after 7 days.'
      : 'Creates a fresh session each run. Expires after 7 days.',
  ].join('\n');
}

async function handleList(authority: AutomationToolAuthority, sessionId: string): Promise<string> {
  // Includes this session's automations plus every durable (app-global) one,
  // so persisted cron jobs stay queryable and manageable after a restart even
  // from a fresh session.
  const automations = await authority.listVisibleForSession(sessionId);
  if (automations.length === 0) return 'No automations for this session.';
  const visible = automations.slice(0, AUTOMATION_MODEL_LIST_MAX_ITEMS);
  const formatted = visible.map((a) => formatAutomation(a));
  if (automations.length > visible.length) {
    formatted.push(`${automations.length - visible.length} additional automations omitted.`);
  }
  return formatted.join('\n---\n');
}

function formatAutomation(a: AutomationDefinition): string {
  // Fire attempts (fireCount) + idle-gate deferrals are model-facing
  // observability, mirroring the old CronList's fire_attempts/deferred_fires.
  const deferred = a.deferredFireCount ?? 0;
  const lines = [
    `[${a.status.toUpperCase()}] ${a.name} (${a.kind}${a.durable ? ', durable' : ''})`,
    `  ID: ${a.id}`,
    `  Schedule: ${describeSchedule(a.schedule)}`,
    `  Fires: ${a.fireCount}${a.maxFires ? `/${a.maxFires}` : ''}${deferred > 0 ? ` (deferred ${deferred} attempt(s) while busy)` : ''}`,
  ];
  if (a.nextFireAt) lines.push(`  Next: ${new Date(a.nextFireAt).toLocaleString()}`);
  if (a.lastFireAt) lines.push(`  Last: ${new Date(a.lastFireAt).toLocaleString()}`);
  if (a.lastError) lines.push(`  Error: ${a.lastError}`);
  if (a.consecutiveFailures > 0) lines.push(`  Consecutive failures: ${a.consecutiveFailures}`);
  return lines.join('\n');
}

function describeSchedule(schedule: AutomationDefinition['schedule']): string {
  switch (schedule.type) {
    case 'cron':
      return `cron "${schedule.expression}"`;
    case 'interval':
      return `every ${schedule.seconds}s`;
    case 'once':
      return `once after ${schedule.delaySeconds}s`;
  }
}
