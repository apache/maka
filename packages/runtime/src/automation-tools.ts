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
  AUTOMATION_MAX_CLIENT_CAPABILITY_REQUIREMENTS,
  AUTOMATION_PROMPT_LIMIT,
  AUTOMATION_PROMPT_MAX_CODE_UNITS,
  isAutomationTextWithinLimit,
} from '@maka/core/automation';
import type { AutomationStatus } from '@maka/core/automation';
import type { MakaTool } from './tool-runtime.js';
import type { AutomationDefinition } from './automation-state.js';

export const AUTOMATION_TOOL_NAME = 'Automation';
export const AUTOMATION_MODEL_LIST_MAX_ITEMS = 100;

export interface AutomationToolAuthority {
  create(input: {
    kind: AutomationDefinition['kind'];
    name: string;
    prompt: string;
    sessionId: string;
    schedule: AutomationDefinition['schedule'];
    maxFires?: number;
    durable?: boolean;
    requiredCapabilityGroups?: readonly string[];
  }): AutomationDefinition | { error: string } | Promise<AutomationDefinition | { error: string }>;
  delete(id: string, sessionId: string): boolean | Promise<boolean>;
  pause(
    id: string,
    sessionId: string,
  ): AutomationDefinition | undefined | Promise<AutomationDefinition | undefined>;
  resume(
    id: string,
    sessionId: string,
  ): AutomationDefinition | undefined | Promise<AutomationDefinition | undefined>;
  get(
    id: string,
    sessionId: string,
  ): AutomationDefinition | undefined | Promise<AutomationDefinition | undefined>;
  listVisibleForSession(
    sessionId: string,
  ): readonly AutomationDefinition[] | Promise<readonly AutomationDefinition[]>;
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
    required_capability_groups: z
      .array(z.string().regex(/^[A-Za-z0-9_-]{1,128}$/))
      .max(AUTOMATION_MAX_CLIENT_CAPABILITY_REQUIREMENTS)
      .refine((values) => new Set(values).size === values.length, {
        message: 'Capability group ids must be unique.',
      })
      .optional()
      .describe(
        '[create] Client Capability group ids returned by load_tools that every fire requires. Omit for Host-native automations.',
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
              : await explainManageFailure(deps.authority, id, ctx.sessionId, 'pause');
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
            return await explainManageFailure(deps.authority, id, ctx.sessionId, 'resume');
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

/**
 * What each status means for pause/resume, in one place.
 *
 * The two facts the refusal text needs — which verb the status admits, and
 * whether the automation is past reviving — used to be hand-rolled literal
 * comparisons, so a fifth AutomationStatus would have compiled clean and
 * quietly told the model that a live automation was beyond repair. A total
 * Record makes the compiler ask for the answer instead.
 */
const AUTOMATION_STATUS_FACTS: Record<
  AutomationStatus,
  { readonly admits: 'pause' | 'resume' | null; readonly terminal: boolean }
> = {
  active: { admits: 'pause', terminal: false },
  paused: { admits: 'resume', terminal: false },
  completed: { admits: null, terminal: true },
  expired: { admits: null, terminal: true },
};

/**
 * Say what actually blocked pause/resume, and what to do about it.
 *
 * "not found, not owned, or not active" folds three independent causes into one
 * sentence and names a next action for none of them. Two of the three are
 * answered by mode "list"; the third is a status the model can neither see nor
 * change by sending the same call again, so it has to be said out loud.
 *
 * The authority only exposes automations this session may manage, so a missing
 * id and another session's id are genuinely indistinguishable here and share
 * one message — but that message points at mode "list", which settles both.
 *
 * Status is the only cause this function can actually read. An authority may
 * refuse for reasons that live outside the automation — the host coordinator
 * turns a retiring or archived session into the same empty result as a
 * wrong-status automation — and in that case the status on record still admits
 * the verb. Saying "it is active, so it cannot be paused" there would be a
 * verdict on something never checked, so that case says the cause was not
 * reported rather than inventing one. Every branch lands on mode "list", which
 * reads state and so survives the session conditions that refuse mutations.
 */
async function explainManageFailure(
  authority: AutomationToolAuthority,
  id: string,
  sessionId: string,
  verb: 'pause' | 'resume',
): Promise<string> {
  const listHint = 'Use mode "list" to see the automations you can manage and their ids.';
  const existing = await authority.get(id, sessionId);
  if (!existing) {
    return `Cannot ${verb} "${id}": this session has no automation with that id. ${listHint}`;
  }
  const facts = AUTOMATION_STATUS_FACTS[existing.status];
  if (facts.admits === verb) {
    return `Cannot ${verb} "${id}": it is ${existing.status}, which is the status ${verb} needs, so its status is not what refused. The reason was not reported here. Use mode "list" to re-read its current state.`;
  }
  if (verb === 'pause') {
    return `Cannot pause "${id}": it is ${existing.status}, and only an active automation can be paused.`;
  }
  return `Cannot resume "${id}": it is ${existing.status}, and only a paused automation can be resumed.${
    facts.terminal ? ' Create a new automation instead.' : ''
  }`;
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
    requiredCapabilityGroups: input.required_capability_groups,
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
  if (a.waiting) lines.push(`  Waiting: ${a.waiting.message}`);
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
